// @ts-check

import {buildCapabilities} from "../capabilities.js"
import {SnapReqAbortError, SnapReqUnsupportedFeatureError} from "../errors.js"
import SnapReqHeaders from "../headers.js"
import SnapReqResponse from "../response.js"

/**
 * Transport backed by `XMLHttpRequest`. A fallback for web environments that
 * lack `fetch`. Buffers the whole response (no incremental streaming) and, like
 * `fetch`, cannot do Unix sockets, client TLS or request-body compression.
 */
export default class XhrTransport {
  /** @returns {string} - Transport name. */
  static get transportName() {
    return "xhr"
  }

  /** @returns {boolean} - Whether this transport can run in the current environment. */
  static isAvailable() {
    return typeof XMLHttpRequest === "function"
  }

  /** @returns {import("../capabilities.js").TransportCapabilities} - Supported capabilities. */
  get capabilities() {
    return buildCapabilities({abort: true})
  }

  /**
   * @param {import("../snap-req.js").NormalizedRequest} request - Normalized request.
   * @returns {Promise<SnapReqResponse>} - The response.
   */
  performRequest(request) {
    if (request.bodyCompression && request.bodyCompression !== "identity") {
      throw new SnapReqUnsupportedFeatureError({feature: "request body compression", transport: "xhr"})
    }

    if (request.body.kind === "stream") {
      throw new SnapReqUnsupportedFeatureError({feature: "streamed request bodies", transport: "xhr"})
    }

    return new Promise((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new SnapReqAbortError())
        return
      }

      const xhr = new XMLHttpRequest()

      xhr.open(request.method, request.url, true)
      xhr.responseType = "arraybuffer"

      if (request.credentials === "include") xhr.withCredentials = true

      for (const [name, value] of request.headers.entries()) xhr.setRequestHeader(name, value)

      const abort = () => xhr.abort()

      request.signal?.addEventListener("abort", abort, {once: true})

      const cleanup = () => request.signal?.removeEventListener("abort", abort)

      xhr.onload = () => {
        cleanup()
        resolve(new SnapReqResponse({
          url: request.url,
          method: request.method,
          status: xhr.status,
          statusText: xhr.statusText,
          headers: this._parseHeaders(xhr.getAllResponseHeaders()),
          bytes: new Uint8Array(/** @type {ArrayBuffer} */ (xhr.response) || new ArrayBuffer(0))
        }))
      }

      xhr.onerror = () => {
        cleanup()
        reject(new Error(`XMLHttpRequest failed for ${request.method} ${request.url}`))
      }

      xhr.onabort = () => {
        cleanup()
        reject(new SnapReqAbortError())
      }

      const body = request.body

      if (body.kind === "none") {
        xhr.send()
      } else {
        xhr.send(/** @type {any} */ (body.value))
      }
    })
  }

  /**
   * @param {string} rawHeaders - Raw header block from `getAllResponseHeaders`.
   * @returns {SnapReqHeaders} - The parsed response headers.
   */
  _parseHeaders(rawHeaders) {
    const headers = new SnapReqHeaders()

    for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
      const separatorIndex = line.indexOf(":")

      if (separatorIndex === -1) continue

      headers.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim())
    }

    return headers
  }
}
