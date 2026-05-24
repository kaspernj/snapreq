// @ts-check

import {buildCapabilities} from "../capabilities.js"
import {SnapReqAbortError, SnapReqUnsupportedFeatureError} from "../errors.js"
import SnapReqHeaders from "../headers.js"
import SnapReqResponse from "../response.js"

/**
 * Transport backed by the `fetch` global. Works on web, Expo / React Native and
 * Node 18+. It cannot open Unix sockets, present client certificates or
 * compress request bodies — those raise `SnapReqUnsupportedFeatureError`.
 * Response streaming uses `response.body` where available and otherwise buffers
 * the body once, keeping the same stream interface everywhere.
 */
export default class FetchTransport {
  /** @returns {string} - Transport name. */
  static get transportName() {
    return "fetch"
  }

  /** @returns {boolean} - Whether this transport can run in the current environment. */
  static isAvailable() {
    return typeof fetch === "function"
  }

  /** @returns {import("../capabilities.js").TransportCapabilities} - Supported capabilities. */
  get capabilities() {
    return buildCapabilities({
      responseStreaming: true,
      abort: true
    })
  }

  /**
   * @param {import("../snap-req.js").NormalizedRequest} request - Normalized request.
   * @returns {Promise<SnapReqResponse>} - The response.
   */
  async performRequest(request) {
    if (request.bodyCompression && request.bodyCompression !== "identity") {
      throw new SnapReqUnsupportedFeatureError({feature: "request body compression", transport: "fetch"})
    }

    /** @type {Record<string, any>} */
    const init = {
      method: request.method,
      headers: request.headers.toObject()
    }

    if (request.signal) init.signal = request.signal
    if (request.credentials) init.credentials = request.credentials

    const body = request.body

    if (body.kind === "text") {
      init.body = body.value
    } else if (body.kind === "bytes") {
      init.body = body.value
    } else if (body.kind === "stream") {
      throw new SnapReqUnsupportedFeatureError({feature: "streamed request bodies", transport: "fetch"})
    }

    /** @type {Response} */
    let fetchResponse

    try {
      fetchResponse = await fetch(request.url, init)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new SnapReqAbortError()

      throw error
    }

    return new SnapReqResponse({
      url: request.url,
      method: request.method,
      status: fetchResponse.status,
      statusText: fetchResponse.statusText,
      headers: this._responseHeaders(fetchResponse),
      stream: this._responseStream(fetchResponse)
    })
  }

  /**
   * @param {Response} response - The fetch response.
   * @returns {SnapReqHeaders} - The response headers.
   */
  _responseHeaders(response) {
    const headers = new SnapReqHeaders()

    response.headers.forEach((value, name) => headers.set(name, value))

    return headers
  }

  /**
   * Builds an async iterable of byte chunks over a fetch response. Uses the
   * `ReadableStream` body for true streaming when present and otherwise buffers
   * the whole body once so the stream interface stays identical everywhere.
   * @param {Response} response - The fetch response.
   * @returns {AsyncIterable<Uint8Array>} - The response body stream.
   */
  _responseStream(response) {
    const body = response.body

    if (body && typeof body.getReader === "function") {
      return (async function* () {
        const reader = body.getReader()

        try {
          while (true) {
            const {done, value} = await reader.read()

            if (done) break
            if (value) yield value instanceof Uint8Array ? value : new Uint8Array(value)
          }
        } finally {
          reader.releaseLock?.()
        }
      })()
    }

    return (async function* () {
      const buffer = await response.arrayBuffer()

      yield new Uint8Array(buffer)
    })()
  }
}
