// @ts-check

import SnapReqHeaders from "./headers.js"

/**
 * Concatenates a list of byte chunks into a single `Uint8Array`.
 * @param {Uint8Array[]} chunks - Byte chunks in order.
 * @returns {Uint8Array} - The concatenated bytes.
 */
function concatChunks(chunks) {
  let total = 0

  for (const chunk of chunks) total += chunk.byteLength

  const result = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }

  return result
}

/**
 * A platform-agnostic response. Transports build it with either a fully-read
 * body (`bytes`) or a `stream` (an async iterable of `Uint8Array`) that the
 * read helpers buffer on first use. The body can be read exactly once as a
 * stream; the buffering helpers may be called repeatedly because they cache.
 */
export default class SnapReqResponse {
  /**
   * @param {object} options - Response data.
   * @param {string} options.url - Fully resolved request URL.
   * @param {string} options.method - HTTP method used for the request.
   * @param {number} options.status - HTTP status code.
   * @param {string} [options.statusText] - HTTP status text.
   * @param {SnapReqHeaders} [options.headers] - Response headers.
   * @param {Uint8Array} [options.bytes] - Fully-read body, when the transport already buffered it.
   * @param {AsyncIterable<Uint8Array>} [options.stream] - Streamed body, when the transport supports streaming.
   * @param {import("node:stream").Readable} [options.nodeStream] - Raw Node stream, when available, for advanced consumers.
   */
  constructor({url, method, status, statusText = "", headers, bytes, stream, nodeStream}) {
    this.url = url
    this.method = method
    this.status = status
    this.statusText = statusText
    this.headers = headers || new SnapReqHeaders()
    /** @type {Uint8Array | null} */
    this._bytes = bytes ?? null
    /** @type {AsyncIterable<Uint8Array> | null} */
    this._stream = stream ?? null
    /** @type {import("node:stream").Readable | undefined} */
    this.nodeStream = nodeStream
    this._streamConsumed = false
  }

  /** @returns {boolean} - Whether the status is in the 2xx range. */
  get ok() {
    return this.status >= 200 && this.status < 300
  }

  /**
   * Returns the response body as an async iterable of byte chunks. Can only be
   * called once and only when the transport provided a stream.
   * @returns {AsyncIterable<Uint8Array>} - The streamed body.
   */
  stream() {
    if (!this._stream) {
      throw new Error("This response has no readable stream (the body was already buffered by the transport).")
    }

    if (this._streamConsumed) {
      throw new Error("This response stream has already been consumed.")
    }

    this._streamConsumed = true

    return this._stream
  }

  /** @returns {boolean} - Whether the body is available as a stream that has not been read yet. */
  get streamable() {
    return Boolean(this._stream) && !this._streamConsumed
  }

  /**
   * Reads the whole body into a `Uint8Array`, buffering the stream if needed.
   * @returns {Promise<Uint8Array>} - The full response body.
   */
  async bytes() {
    if (this._bytes) return this._bytes

    if (!this._stream) {
      this._bytes = new Uint8Array(0)

      return this._bytes
    }

    if (this._streamConsumed) {
      throw new Error("Cannot buffer this response: its stream was already consumed via stream().")
    }

    this._streamConsumed = true

    /** @type {Uint8Array[]} */
    const chunks = []

    for await (const chunk of this._stream) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
    }

    this._bytes = concatChunks(chunks)

    return this._bytes
  }

  /**
   * Reads the whole body as a Node `Buffer`. Node-only convenience; throws when
   * the `Buffer` global is unavailable.
   * @returns {Promise<Buffer>} - The full response body as a Buffer.
   */
  async buffer() {
    if (typeof Buffer === "undefined") {
      throw new Error("Buffer is not available on this platform; use bytes() instead.")
    }

    const bytes = await this.bytes()

    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  /**
   * Reads the whole body and decodes it as a UTF-8 string.
   * @returns {Promise<string>} - The decoded response body.
   */
  async text() {
    const bytes = await this.bytes()

    return new TextDecoder("utf-8").decode(bytes)
  }

  /**
   * Reads the whole body and parses it as JSON. Returns `null` for an empty
   * body.
   * @returns {Promise<any>} - The parsed JSON body.
   */
  async json() {
    const text = await this.text()

    if (!text) return null

    return JSON.parse(text)
  }
}
