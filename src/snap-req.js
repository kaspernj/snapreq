// @ts-check

import {SnapReqAbortError, SnapReqHttpError, SnapReqRedirectError, SnapReqResponseTooLargeError, SnapReqTimeoutError, SnapReqUnsupportedFeatureError} from "./errors.js"
import SnapReqHeaders from "./headers.js"
import {buildUrl, normalizeBody} from "./request.js"
import {normalizeRetryOptions, runWithRetry} from "./retry.js"
import {selectTransport} from "./transports/select.js"
import {HttpRequestControl} from "./control.js"

/**
 * @typedef {import("./request.js").CompressionEncoding} CompressionEncoding
 */

/** @typedef {"error" | "follow" | "manual"} RedirectPolicy */

/**
 * @typedef {object} NormalizedRequest
 * @property {string} method - Upper-cased HTTP method.
 * @property {string} url - Fully resolved request URL.
 * @property {SnapReqHeaders} headers - Request headers.
 * @property {import("./request.js").NormalizedBody} body - Normalized request body.
 * @property {CompressionEncoding} bodyCompression - Request body compression.
 * @property {AbortSignal} [signal] - Abort signal.
 * @property {number} [timeoutMs] - Request timeout in milliseconds.
 * @property {number} [idleTimeoutMs] - Request inactivity timeout in milliseconds.
 * @property {(phase: import("./control.js").HttpRequestProgressPhase) => void} [onProgress] - Internal transport progress hook.
 * @property {string} [credentials] - Fetch credentials mode ("omit" | "same-origin" | "include").
 * @property {RedirectPolicy} [redirect] - Explicit redirect policy; omission keeps transport-native behavior.
 * @property {number} maxRedirects - Maximum followed redirects.
 * @property {number} [maxResponseBytes] - Maximum decoded response bytes that may be consumed.
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
 * @property {number} [timeoutMs] - Request timeout in milliseconds. Set to `0` to disable a client default.
 * @property {number} [idleTimeoutMs] - Inactivity timeout in milliseconds. Set to `0` to disable a client default.
 * @property {string} [credentials] - Fetch credentials mode.
 * @property {boolean | import("./retry.js").RetryOptions} [retry] - Retry transient failures.
 * @property {boolean} [throwOnError] - Throw `SnapReqHttpError` on non-2xx responses.
 * @property {RedirectPolicy} [redirect] - Explicit redirect policy; omission keeps transport-native behavior.
 * @property {number} [maxRedirects] - Maximum followed redirects. Defaults to 10.
 * @property {number} [maxResponseBytes] - Maximum decoded response bytes that may be consumed.
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
   * @param {number} [config.timeoutMs] - Default request timeout in milliseconds. Set per-request `timeoutMs: 0` to disable.
   * @param {number} [config.idleTimeoutMs] - Default inactivity timeout in milliseconds. Set per-request `idleTimeoutMs: 0` to disable.
   * @param {string} [config.credentials] - Default fetch credentials mode.
   * @param {import("./transports/select.js").TransportName | import("./transports/select.js").Transport} [config.transport] - Transport preference or instance. Defaults to "auto".
   * @param {RedirectPolicy} [config.redirect] - Explicit redirect policy; omission keeps transport-native behavior.
   * @param {number} [config.maxRedirects] - Maximum followed redirects. Defaults to 10.
   * @param {number} [config.maxResponseBytes] - Maximum decoded response bytes that may be consumed.
   */
  constructor({baseUrl, socketPath, tls, keepAlive = true, headers, retry, throwOnError = false, timeoutMs, idleTimeoutMs, credentials, transport = "auto", redirect, maxRedirects = 10, maxResponseBytes} = {}) {
    this._validateRedirectPolicy(redirect)
    this._validateByteLimit(maxRedirects, "maxRedirects")
    this._validateByteLimit(maxResponseBytes, "maxResponseBytes", true)
    this.baseUrl = baseUrl
    this.defaultHeaders = headers
    this.defaultRetry = retry
    this.throwOnError = throwOnError
    this.timeoutMs = timeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    this.credentials = credentials
    this.redirect = redirect
    this.maxRedirects = maxRedirects
    this.maxResponseBytes = maxResponseBytes
    this._transportPreference = transport
    this._nodeConfig = {socketPath, tls, keepAlive}
    /** @type {Promise<import("./transports/select.js").Transport> | null} */
    this._transportPromise = null
    /** @type {import("./transports/select.js").Transport | null} */
    this._transport = null
  }

  /**
   * @param {RedirectPolicy | undefined} redirect - Redirect policy.
   * @returns {void}
   */
  _validateRedirectPolicy(redirect) {
    if (redirect !== undefined && !["error", "follow", "manual"].includes(redirect)) {
      throw new TypeError(`redirect must be "error", "follow" or "manual", got: ${redirect}`)
    }
  }

  /**
   * @param {number | undefined} value - Integer option.
   * @param {string} name - Option name.
   * @param {boolean} [allowZero] - Whether zero is accepted.
   * @returns {void}
   */
  _validateByteLimit(value, name, allowZero = false) {
    if (value === undefined) return
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer, got: ${value}`)
    }
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
    const redirect = options.redirect ?? this.redirect
    const maxRedirects = options.maxRedirects ?? this.maxRedirects
    const maxResponseBytes = options.maxResponseBytes ?? this.maxResponseBytes

    this._validateRedirectPolicy(redirect)
    this._validateByteLimit(maxRedirects, "maxRedirects")
    this._validateByteLimit(maxResponseBytes, "maxResponseBytes", true)

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
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? this.idleTimeoutMs,
      credentials: options.credentials ?? this.credentials,
      redirect,
      maxRedirects,
      maxResponseBytes
    }
  }

  /**
   * @param {(() => void) | undefined} existing - Existing body-done callback.
   * @param {() => void} next - Callback to add.
   * @returns {() => void} - Combined callback.
   */
  _chainBodyDone(existing, next) {
    return () => {
      try {
        if (existing) existing()
      } finally {
        next()
      }
    }
  }

  /**
   * @param {(() => void) | undefined} existing - Existing body-progress callback.
   * @param {() => void} next - Callback to add.
   * @returns {() => void} - Combined callback.
   */
  _chainBodyProgress(existing, next) {
    return () => {
      if (existing) existing()
      next()
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
    const transport = await this._resolveTransport()
    const throwOnError = options.throwOnError ?? this.throwOnError
    const retry = normalizeRetryOptions(options.retry ?? this.defaultRetry)
    const body = normalizeBody(options.body, new SnapReqHeaders(options.headers))
    const canRetry = retry && body.kind !== "stream"
    const attempt = async (signal = options.signal) => this._requestWithTimeout({...options, signal}, (request) => transport.performRequest(request))
    let response

    try {
      response = canRetry
        ? await runWithRetry(attempt, /** @type {any} */ (retry), options.signal)
        : await attempt()
    } catch (error) {
      if (options.signal?.aborted && error === options.signal.reason) throw new SnapReqAbortError()

      throw error
    }

    if (throwOnError && !response.ok) throw await this._httpError(response)

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
    const transport = await this._resolveTransport()

    if (!transport.capabilities.responseStreaming) {
      throw new SnapReqUnsupportedFeatureError({
        feature: "response streaming",
        transport: /** @type {any} */ (transport.constructor)?.transportName || "custom"
      })
    }

    const response = await this._requestWithTimeout(options, (request) => transport.performRequest(request))

    if ((options.throwOnError ?? this.throwOnError) && !response.ok) {
      throw await this._httpError(response)
    }

    return response
  }

  /**
   * @param {RequestOptions} options - Request options.
   * @param {(request: NormalizedRequest) => Promise<import("./response.js").default>} performRequest - Transport request runner.
   * @returns {Promise<import("./response.js").default>} - Response with timeout handling attached.
   */
  async _requestWithTimeout(options, performRequest) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const idleTimeoutMs = options.idleTimeoutMs ?? this.idleTimeoutMs
    const normalized = this._normalize(options)
    const control = new HttpRequestControl({
      idleTimeoutMs,
      method: normalized.method,
      signal: options.signal,
      timeoutMs,
      url: normalized.url
    })

    normalized.signal = control.signal
    normalized.onProgress = (phase) => control.progress(phase)

    try {
      control.signal.throwIfAborted()

      const response = await control.run(() => this._performWithRedirects(normalized, performRequest))

      response._setMaxResponseBytes(normalized.maxResponseBytes)

      const mapBodyError = response._mapBodyError

      response._mapBodyError = (error) => {
        if (control.error) return control.error

        return mapBodyError ? mapBodyError(error) : error
      }

      response._onBodyProgress = this._chainBodyProgress(response._onBodyProgress, () => control.progress("response_body"))
      response._onBodyDone = this._chainBodyDone(response._onBodyDone, () => control.finish())
      control.progress("response_body")
      control.setBodyCancellation((error) => response._abortBody(error))

      if (response._bodyDone) control.finish()
      if (control.error) throw control.error

      return response
    } catch (error) {
      const requestError = control.error || error

      control.finish()

      throw requestError
    }
  }

  /**
   * Performs the transport requests required by one explicit redirect policy.
   * @param {NormalizedRequest} initialRequest - Initial normalized request.
   * @param {(request: NormalizedRequest) => Promise<import("./response.js").default>} performRequest - Single-request transport runner.
   * @returns {Promise<import("./response.js").default>} - Final or manually exposed response.
   */
  async _performWithRedirects(initialRequest, performRequest) {
    let request = initialRequest
    let followedRedirects = 0

    while (true) {
      const response = await performRequest(request)

      request.onProgress?.("connect_or_headers")

      if (!request.redirect || request.redirect === "manual" || !this._isRedirectResponse(response.status)) return response

      const location = response.headers.get("location")

      if (request.redirect === "error") {
        const error = new SnapReqRedirectError({location, policy: "error", status: response.status, url: response.url})

        response._abortBody(error)
        throw error
      }

      if (!location) {
        const error = new SnapReqRedirectError({location, policy: "follow", status: response.status, url: response.url})

        response._abortBody(error)
        throw error
      }

      if (followedRedirects >= request.maxRedirects) {
        const error = new SnapReqRedirectError({
          location,
          maxRedirects: request.maxRedirects,
          policy: "follow",
          status: response.status,
          url: response.url
        })

        response._abortBody(error)
        throw error
      }

      const nextUrl = new URL(location, response.url)

      if (!new Set(["http:", "https:"]).has(nextUrl.protocol)) {
        const error = new SnapReqRedirectError({location, policy: "follow", status: response.status, url: response.url})

        response._abortBody(error)
        throw error
      }

      response._abortBody(new SnapReqRedirectError({location, policy: "follow", status: response.status, url: response.url}))
      const nextRequest = this._redirectedRequest(request, response.status, nextUrl)

      followedRedirects += 1
      request = nextRequest
    }
  }

  /**
   * @param {number} status - HTTP status.
   * @returns {boolean} - Whether it is a redirect status.
   */
  _isRedirectResponse(status) {
    return [301, 302, 303, 307, 308].includes(status)
  }

  /**
   * @param {NormalizedRequest} request - Previous request.
   * @param {number} status - Redirect response status.
   * @param {URL} nextUrl - Resolved redirect target.
   * @returns {NormalizedRequest} - Redirected request.
   */
  _redirectedRequest(request, status, nextUrl) {
    const headers = new SnapReqHeaders(request.headers)
    const previousUrl = new URL(request.url)
    const changesToGet = status === 303 && request.method !== "HEAD" || [301, 302].includes(status) && request.method === "POST"

    if (previousUrl.origin !== nextUrl.origin) {
      for (const name of ["Authorization", "Cookie", "Proxy-Authorization"]) headers.delete(name)
    }

    if (changesToGet) {
      for (const name of ["Content-Encoding", "Content-Length", "Content-Type"]) headers.delete(name)
    } else if (request.body.kind === "stream") {
      throw new SnapReqRedirectError({location: nextUrl.href, policy: "follow", status, url: request.url})
    }

    return {
      ...request,
      body: changesToGet ? {kind: "none", value: null} : request.body,
      bodyCompression: changesToGet ? "identity" : request.bodyCompression,
      credentials: previousUrl.origin === nextUrl.origin ? request.credentials : "omit",
      headers,
      method: changesToGet ? "GET" : request.method,
      url: nextUrl.href
    }
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
   * @returns {Promise<SnapReqHttpError>} - An error describing the failure.
   */
  async _httpError(response) {
    let responseText = ""

    try {
      responseText = await response.text()
    } catch (error) {
      if (error instanceof SnapReqTimeoutError || error instanceof SnapReqAbortError || error instanceof SnapReqResponseTooLargeError) throw error

      // Body unavailable (already streamed or read error) — fall back to status text.
    }

    const detail = responseText || response.statusText || ""

    return new SnapReqHttpError({
      message: `HTTP ${response.status} ${response.method} ${response.url}${detail ? `: ${detail}` : ""}`,
      method: response.method,
      url: response.url,
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
