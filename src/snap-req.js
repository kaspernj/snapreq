// @ts-check

import {SnapReqHttpError, SnapReqUnsupportedFeatureError} from "./errors.js"
import SnapReqHeaders from "./headers.js"
import {buildUrl, normalizeBody} from "./request.js"
import {normalizeRetryOptions, runWithRetry} from "./retry.js"
import {selectTransport} from "./transports/select.js"

/**
 * @typedef {import("./request.js").CompressionEncoding} CompressionEncoding
 */

/**
 * @typedef {object} NormalizedRequest
 * @property {string} method - Upper-cased HTTP method.
 * @property {string} url - Fully resolved request URL.
 * @property {SnapReqHeaders} headers - Request headers.
 * @property {import("./request.js").NormalizedBody} body - Normalized request body.
 * @property {CompressionEncoding} bodyCompression - Request body compression.
 * @property {AbortSignal} [signal] - Abort signal.
 * @property {string} [credentials] - Fetch credentials mode ("omit" | "same-origin" | "include").
 */

/**
 * @typedef {object} RequestOptions
 * @property {string} [method] - HTTP method. Defaults to GET.
 * @property {string} [path] - Request path (joined with the client `baseUrl`) or absolute URL.
 * @property {string} [url] - Alias for `path`.
 * @property {Record<string, string | number | boolean | null | undefined>} [query] - Query parameters.
 * @property {Record<string, string | number> | SnapReqHeaders} [headers] - Per-request headers.
 * @property {any} [body] - Request body: string, object (JSON), Uint8Array/ArrayBuffer, or a stream/async-iterable.
 * @property {CompressionEncoding} [bodyCompression] - Compress the request body (Node transport only).
 * @property {AbortSignal} [signal] - Abort signal for the request.
 * @property {string} [credentials] - Fetch credentials mode.
 * @property {boolean | import("./retry.js").RetryOptions} [retry] - Retry transient failures.
 * @property {boolean} [throwOnError] - Throw `SnapReqHttpError` on non-2xx responses.
 */

/**
 * A cross-platform HTTP client with one API across Node, web, Expo and React
 * Native. The right transport is chosen at runtime; features a platform cannot
 * provide raise `SnapReqUnsupportedFeatureError` rather than silently changing
 * behaviour.
 */
export default class SnapReq {
  /**
   * @param {object} [config] - Client configuration.
   * @param {string} [config.baseUrl] - Origin (and optional base path) prepended to relative paths.
   * @param {string} [config.socketPath] - Unix domain socket path (Node transport only).
   * @param {{ca?: string | Buffer, cert?: string | Buffer, key?: string | Buffer, rejectUnauthorized?: boolean}} [config.tls] - TLS material (Node transport only).
   * @param {boolean} [config.keepAlive] - Reuse connections across requests (Node transport only). Defaults to true.
   * @param {Record<string, string | number> | (() => Record<string, string | number>)} [config.headers] - Default headers (object or factory).
   * @param {boolean | import("./retry.js").RetryOptions} [config.retry] - Default retry policy.
   * @param {boolean} [config.throwOnError] - Throw `SnapReqHttpError` on non-2xx responses by default. Defaults to false.
   * @param {string} [config.credentials] - Default fetch credentials mode.
   * @param {import("./transports/select.js").TransportName | import("./transports/select.js").Transport} [config.transport] - Transport preference or instance. Defaults to "auto".
   */
  constructor({baseUrl, socketPath, tls, keepAlive = true, headers, retry, throwOnError = false, credentials, transport = "auto"} = {}) {
    this.baseUrl = baseUrl
    this.defaultHeaders = headers
    this.defaultRetry = retry
    this.throwOnError = throwOnError
    this.credentials = credentials
    this._transportPreference = transport
    this._nodeConfig = {socketPath, tls, keepAlive}
    /** @type {Promise<import("./transports/select.js").Transport> | null} */
    this._transportPromise = null
    /** @type {import("./transports/select.js").Transport | null} */
    this._transport = null
  }

  /** @returns {Promise<import("./transports/select.js").Transport>} - The resolved transport. */
  async _resolveTransport() {
    this._transportPromise ||= selectTransport(this._transportPreference, this._nodeConfig)
    this._transport = await this._transportPromise

    return this._transport
  }

  /** @returns {Promise<import("./capabilities.js").TransportCapabilities>} - The active transport's capabilities. */
  async capabilities() {
    return (await this._resolveTransport()).capabilities
  }

  /** @returns {Promise<string>} - The active transport's name. */
  async transportName() {
    const transport = await this._resolveTransport()

    return /** @type {any} */ (transport.constructor)?.transportName || "custom"
  }

  /**
   * @param {RequestOptions} options - Request options.
   * @returns {NormalizedRequest} - The normalized request.
   */
  _normalize(options) {
    const headers = new SnapReqHeaders()
    const defaults = typeof this.defaultHeaders === "function" ? this.defaultHeaders() : this.defaultHeaders

    if (defaults) for (const [name, value] of new SnapReqHeaders(defaults).entries()) headers.set(name, value)
    if (options.headers) for (const [name, value] of new SnapReqHeaders(options.headers).entries()) headers.set(name, value)

    const url = buildUrl(this.baseUrl, options.path ?? options.url ?? "", options.query)
    const body = normalizeBody(options.body, headers)

    return {
      method: (options.method || "GET").toUpperCase(),
      url,
      headers,
      body,
      bodyCompression: options.bodyCompression || "identity",
      signal: options.signal,
      credentials: options.credentials ?? this.credentials
    }
  }

  /**
   * Performs a request and buffers nothing eagerly — read the body via the
   * returned response (`json()`, `text()`, `bytes()`). Retries transient
   * failures when a retry policy is configured (never for streamed bodies).
   * @param {RequestOptions} options - Request options.
   * @returns {Promise<import("./response.js").default>} - The response.
   */
  async request(options) {
    const normalized = this._normalize(options)
    const transport = await this._resolveTransport()
    const throwOnError = options.throwOnError ?? this.throwOnError
    const retry = normalizeRetryOptions(options.retry ?? this.defaultRetry)
    const canRetry = retry && normalized.body.kind !== "stream"

    const attempt = () => transport.performRequest(normalized)
    const response = canRetry ? await runWithRetry(attempt, /** @type {any} */ (retry)) : await attempt()

    if (throwOnError && !response.ok) throw await this._httpError(response, normalized)

    return response
  }

  /**
   * Performs a request and returns the response with its body available as a
   * stream (`response.stream()`). Requires a transport that supports response
   * streaming; never retries.
   * @param {RequestOptions} options - Request options.
   * @returns {Promise<import("./response.js").default>} - The streaming response.
   */
  async requestStream(options) {
    const normalized = this._normalize(options)
    const transport = await this._resolveTransport()

    if (!transport.capabilities.responseStreaming) {
      throw new SnapReqUnsupportedFeatureError({
        feature: "response streaming",
        transport: /** @type {any} */ (transport.constructor)?.transportName || "custom"
      })
    }

    const response = await transport.performRequest(normalized)

    if ((options.throwOnError ?? this.throwOnError) && !response.ok) {
      throw await this._httpError(response, normalized)
    }

    return response
  }

  /**
   * @param {string} path - Request path or absolute URL.
   * @param {RequestOptions} [options] - Request options.
   * @returns {Promise<import("./response.js").default>} - The response.
   */
  get(path, options = {}) {
    return this.request({...options, method: "GET", path})
  }

  /**
   * @param {string} path - Request path or absolute URL.
   * @param {any} [body] - Request body.
   * @param {RequestOptions} [options] - Request options.
   * @returns {Promise<import("./response.js").default>} - The response.
   */
  post(path, body, options = {}) {
    return this.request({...options, method: "POST", path, body})
  }

  /**
   * @param {string} path - Request path or absolute URL.
   * @param {any} [body] - Request body.
   * @param {RequestOptions} [options] - Request options.
   * @returns {Promise<import("./response.js").default>} - The response.
   */
  put(path, body, options = {}) {
    return this.request({...options, method: "PUT", path, body})
  }

  /**
   * @param {string} path - Request path or absolute URL.
   * @param {any} [body] - Request body.
   * @param {RequestOptions} [options] - Request options.
   * @returns {Promise<import("./response.js").default>} - The response.
   */
  patch(path, body, options = {}) {
    return this.request({...options, method: "PATCH", path, body})
  }

  /**
   * @param {string} path - Request path or absolute URL.
   * @param {RequestOptions} [options] - Request options.
   * @returns {Promise<import("./response.js").default>} - The response.
   */
  delete(path, options = {}) {
    return this.request({...options, method: "DELETE", path})
  }

  /**
   * @param {import("./response.js").default} response - The failed response.
   * @param {NormalizedRequest} request - The request that produced it.
   * @returns {Promise<SnapReqHttpError>} - An error describing the failure.
   */
  async _httpError(response, request) {
    let responseText = ""

    try {
      responseText = await response.text()
    } catch {
      // Body unavailable (already streamed or read error) — fall back to status text.
    }

    const detail = responseText || response.statusText || ""

    return new SnapReqHttpError({
      message: `HTTP ${response.status} ${request.method} ${request.url}${detail ? `: ${detail}` : ""}`,
      method: request.method,
      url: request.url,
      status: response.status,
      statusText: response.statusText,
      responseText,
      response
    })
  }

  /**
   * Releases transport resources (for example Node keep-alive sockets).
   * @returns {void}
   */
  close() {
    this._transport?.close?.()
  }
}
