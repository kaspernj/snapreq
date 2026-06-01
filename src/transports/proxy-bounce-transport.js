// @ts-check

import {buildCapabilities} from "../capabilities.js"
import {SnapReqUnsupportedFeatureError} from "../errors.js"
import SnapReqHeaders from "../headers.js"
import SnapReqResponse from "../response.js"

/**
 * @param {Uint8Array} bytes - Bytes to encode.
 * @returns {string} - Base64 string.
 */
function base64Encode(bytes) {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")

  return btoa(binary)
}

/**
 * @param {string} base64 - Base64-encoded string.
 * @returns {Uint8Array} - Decoded bytes.
 */
function base64Decode(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

/**
 * Transport that bounces every request through a same-origin proxy endpoint.
 * Used when the real target is a different origin and CORS would block direct
 * browser `fetch` calls. The proxy backend makes the outbound request
 * server-side where CORS does not apply.
 */
export default class ProxyBounceTransport {
  /**
   * @param {object} config - Transport configuration.
   * @param {string} config.proxyUrl - Absolute URL of the proxy endpoint.
   */
  constructor({proxyUrl}) {
    this.proxyUrl = proxyUrl
  }

  /** @returns {string} - Transport name. */
  static get transportName() {
    return "proxy-bounce"
  }

  /** @returns {import("../capabilities.js").TransportCapabilities} - Supported capabilities. */
  get capabilities() {
    return buildCapabilities({abort: true})
  }

  /**
   * @param {import("../snap-req.js").NormalizedRequest} request - Normalized request.
   * @returns {Promise<SnapReqResponse>} - The response.
   */
  async performRequest(request) {
    const requestBody = request.body

    /** @type {string | null} */
    let serializedBody = null

    /** @type {string | undefined} */
    let bodyEncoding

    if (requestBody.kind === "text") {
      serializedBody = /** @type {string} */ (requestBody.value)
    } else if (requestBody.kind === "bytes") {
      serializedBody = base64Encode(/** @type {Uint8Array} */ (requestBody.value))
      bodyEncoding = "base64"
    } else if (requestBody.kind === "stream") {
      throw new SnapReqUnsupportedFeatureError({feature: "streamed request bodies", transport: "proxy-bounce"})
    }

    /** @type {Record<string, any>} */
    const proxyPayload = {
      body: serializedBody,
      headers: request.headers.toObject(),
      method: request.method,
      url: request.url
    }

    if (bodyEncoding) {
      proxyPayload.bodyEncoding = bodyEncoding
    }

    /** @type {Response} */
    let proxyResponse

    try {
      proxyResponse = await fetch(this.proxyUrl, {
        body: JSON.stringify(proxyPayload),
        headers: {"Content-Type": "application/json"},
        method: "POST",
        signal: request.signal || undefined
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error
      }

      throw error
    }

    const payload = await proxyResponse.json()

    const responseHeaders = new SnapReqHeaders()

    if (payload.headers) {
      for (const [name, value] of Object.entries(payload.headers)) {
        responseHeaders.set(name, String(value))
      }
    }

    /** @type {Uint8Array} */
    let bodyBytes = new Uint8Array(0)

    if (payload.body) {
      bodyBytes = base64Decode(payload.body)
    }

    return new SnapReqResponse({
      bytes: bodyBytes,
      headers: responseHeaders,
      method: request.method,
      status: payload.status,
      statusText: payload.statusText || "",
      url: request.url
    })
  }
}
