// @ts-check

/** Base class for every error thrown by snapreq. */
export class SnapReqError extends Error {
  /** @param {string} message - Human readable description. */
  constructor(message) {
    super(message)
    this.name = "SnapReqError"
  }
}

/**
 * Thrown when a request completes with a non-2xx status and the caller asked
 * snapreq to treat error statuses as failures (`throwOnError`, the default for
 * the high-level helpers). Carries enough metadata to build a friendly message
 * without re-reading the response.
 */
export class SnapReqHttpError extends SnapReqError {
  /**
   * @param {object} options - Error metadata.
   * @param {string} options.message - Human readable description.
   * @param {string} options.method - HTTP method used for the request.
   * @param {string} options.url - Fully resolved request URL.
   * @param {number} options.status - HTTP status code returned by the server.
   * @param {string} [options.statusText] - HTTP status text returned by the server.
   * @param {string} [options.responseText] - Decoded response body, when available.
   * @param {import("./response.js").default} [options.response] - The response that failed.
   */
  constructor({message, method, url, status, statusText, responseText, response}) {
    super(message)
    this.name = "SnapReqHttpError"
    this.method = method
    this.url = url
    this.status = status
    this.statusText = statusText
    this.responseText = responseText
    this.response = response
  }
}

/**
 * Thrown when a request asks for a capability the active transport cannot
 * provide on the current platform (for example a Unix socket or request-body
 * compression in a browser). The API stays identical across platforms; this
 * error is how snapreq tells you a specific feature had to be left out.
 */
export class SnapReqUnsupportedFeatureError extends SnapReqError {
  /**
   * @param {object} options - Error metadata.
   * @param {string} options.feature - The capability that is not supported.
   * @param {string} options.transport - Name of the active transport.
   * @param {string} [options.detail] - Optional extra context.
   */
  constructor({feature, transport, detail}) {
    super(`The "${transport}" transport does not support ${feature}${detail ? `: ${detail}` : ""}.`)
    this.name = "SnapReqUnsupportedFeatureError"
    this.feature = feature
    this.transport = transport
  }
}

/** Thrown when a request is aborted via an `AbortSignal`. */
export class SnapReqAbortError extends SnapReqError {
  /** @param {string} [message] - Human readable description. */
  constructor(message = "Request aborted.") {
    super(message)
    this.name = "SnapReqAbortError"
  }
}
