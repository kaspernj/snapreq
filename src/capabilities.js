// @ts-check

/**
 * @typedef {object} TransportCapabilities
 * @property {boolean} unixSocket - Connect over a Unix domain socket.
 * @property {boolean} tlsClientCert - Present a client certificate / custom CA for TLS.
 * @property {boolean} requestCompression - Compress the request body (gzip/deflate/br/zstd).
 * @property {boolean} responseStreaming - Expose the response body as a stream before it is fully read.
 * @property {boolean} requestStreaming - Send a streamed (async-iterable) request body.
 * @property {boolean} keepAlive - Reuse connections across requests (HTTP keep-alive).
 * @property {boolean} abort - Cancel an in-flight request via an `AbortSignal`.
 */

/**
 * Builds a fully-populated capability object so callers can read every flag
 * without undefined checks.
 * @param {Partial<TransportCapabilities>} overrides - Capabilities the transport supports.
 * @returns {TransportCapabilities} - Complete capability flags.
 */
export function buildCapabilities(overrides) {
  return {
    unixSocket: false,
    tlsClientCert: false,
    requestCompression: false,
    responseStreaming: false,
    requestStreaming: false,
    keepAlive: false,
    abort: false,
    ...overrides
  }
}
