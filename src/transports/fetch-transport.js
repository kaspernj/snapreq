// @ts-check

import {buildCapabilities} from "../capabilities.js"
import {SnapReqAbortError, SnapReqRedirectError, SnapReqUnsupportedFeatureError} from "../errors.js"
import SnapReqHeaders from "../headers.js"
import SnapReqResponse from "../response.js"

const FETCH_NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/**
 * @param {Uint8Array} bytes - Already-complete response bytes.
 * @yields {Uint8Array} - The non-empty response bytes, when present.
 */
async function* completedByteStream(bytes) {
  if (bytes.byteLength > 0) yield bytes
}

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

    if (request.idleTimeoutMs && request.idleTimeoutMs > 0 && request.body.kind !== "none") {
      throw new SnapReqUnsupportedFeatureError({
        feature: "idle timeouts for request bodies",
        transport: "fetch",
        detail: "fetch does not expose upload progress"
      })
    }

    /** @type {Record<string, any>} */
    const init = {
      method: request.method,
      headers: request.headers.toObject()
    }

    if (request.redirect) init.redirect = "manual"

    const bodyController = new AbortController()
    const requestSignal = request.signal
    const forwardAbort = () => bodyController.abort(requestSignal?.reason)
    const finishBodyControl = () => requestSignal?.removeEventListener("abort", forwardAbort)

    if (requestSignal?.aborted) {
      forwardAbort()
    } else {
      requestSignal?.addEventListener("abort", forwardAbort, {once: true})
    }

    init.signal = bodyController.signal
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
      requestSignal?.removeEventListener("abort", forwardAbort)
      if (error instanceof Error && error.name === "AbortError") throw new SnapReqAbortError()

      throw error
    }

    if (fetchResponse.type === "opaqueredirect" && request.redirect === "error") {
      finishBodyControl()
      throw new SnapReqRedirectError({location: null, policy: "error", status: 0, url: request.url})
    }

    if (fetchResponse.type === "opaqueredirect" && request.redirect === "follow") {
      finishBodyControl()
      throw new SnapReqUnsupportedFeatureError({
        feature: "cross-origin redirect following",
        transport: "fetch",
        detail: "manual Fetch redirects do not expose the target URL or headers"
      })
    }

    if (!fetchResponse.body && (request.method === "HEAD" || FETCH_NULL_BODY_STATUSES.has(fetchResponse.status))) {
      finishBodyControl()
      const bytes = new Uint8Array(0)

      return new SnapReqResponse({
        url: request.url,
        method: request.method,
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: this._responseHeaders(fetchResponse),
        bytes,
        stream: completedByteStream(bytes)
      })
    }

    if (
      request.idleTimeoutMs &&
      request.idleTimeoutMs > 0 &&
      (!fetchResponse.body || typeof fetchResponse.body.getReader !== "function")
    ) {
      const error = new SnapReqUnsupportedFeatureError({
        feature: "idle timeouts for buffered responses",
        transport: "fetch",
        detail: "this fetch implementation does not expose response progress"
      })

      bodyController.abort(error)
      finishBodyControl()
      throw error
    }

    const responseStream = this._responseStream(fetchResponse, {
      cancel: (reason) => {
        bodyController.abort(reason)
        finishBodyControl()
      },
      onDone: finishBodyControl
    })

    return new SnapReqResponse({
      url: request.url,
      method: request.method,
      status: fetchResponse.status,
      statusText: fetchResponse.statusText,
      headers: this._responseHeaders(fetchResponse),
      stream: responseStream,
      cancelBody: (error) => {
        try {
          responseStream.cancel?.(error)
        } finally {
          finishBodyControl()
        }
      }
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
   * @param {{cancel: (reason?: unknown) => void, onDone: () => void}} control - Body lifetime controls.
   * @returns {AsyncIterable<Uint8Array> & {cancel?: (reason?: unknown) => void}} - The response body stream.
   */
  _responseStream(response, control) {
    const body = response.body

    if (body && typeof body.getReader === "function") {
      /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
      let reader = null
      const iterable = (async function* () {
        reader = body.getReader()

        try {
          while (true) {
            const {done, value} = await reader.read()

            if (done) break
            if (value) yield value instanceof Uint8Array ? value : new Uint8Array(value)
          }
        } finally {
          if (reader) {
            try {
              await reader.cancel()
            } catch {
              // The body may already be errored by an abort.
            }
            reader.releaseLock?.()
          }
          control.onDone()
        }
      })()

      const cancellable = /** @type {AsyncIterable<Uint8Array> & {cancel: (reason?: unknown) => void}} */ (/** @type {unknown} */ (iterable))

      cancellable.cancel = (reason) => {
        if (reader) void reader.cancel(reason)
        else void body.cancel(reason)
      }
      return cancellable
    }

    const iterable = (async function* () {
      try {
        const buffer = await response.arrayBuffer()

        yield new Uint8Array(buffer)
      } finally {
        control.onDone()
      }
    })()
    const cancellable = /** @type {AsyncIterable<Uint8Array> & {cancel: (reason?: unknown) => void}} */ (/** @type {unknown} */ (iterable))

    cancellable.cancel = control.cancel
    return cancellable
  }
}
