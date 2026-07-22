// @ts-check

import {buildCapabilities} from "../capabilities.js"
import {SnapReqAbortError, SnapReqUnsupportedFeatureError} from "../errors.js"
import SnapReqHeaders from "../headers.js"
import SnapReqResponse from "../response.js"

/**
 * Full-featured transport backed by Node's `http`/`https` modules. Supports
 * Unix sockets, client TLS, keep-alive, request-body compression, response
 * decompression and streaming. The `node:*` modules are loaded with a dynamic
 * `import()` so this file never has to be bundled by web/Expo bundlers — the
 * transport selector only imports it when running on Node.
 */
export default class NodeTransport {
  /** @returns {string} - Transport name. */
  static get transportName() {
    return "node"
  }

  /** @returns {boolean} - Whether this transport can run in the current environment. */
  static isAvailable() {
    return typeof process !== "undefined" && Boolean(process.versions?.node)
  }

  /**
   * @param {object} [config] - Transport configuration.
   * @param {string} [config.socketPath] - Unix domain socket path.
   * @param {{ca?: string | Buffer, cert?: string | Buffer, key?: string | Buffer, rejectUnauthorized?: boolean}} [config.tls] - TLS material for HTTPS connections.
   * @param {boolean} [config.keepAlive] - Reuse connections across requests. Defaults to true.
   */
  constructor({socketPath, tls, keepAlive = true} = {}) {
    this.socketPath = socketPath
    this.tls = tls
    this.keepAlive = keepAlive
    /** @type {{http: any, https: any, zlib: any, stream: any} | null} */
    this._modules = null
    /** @type {any} */
    this._httpAgent = null
    /** @type {any} */
    this._httpsAgent = null
  }

  /** @returns {import("../capabilities.js").TransportCapabilities} - Supported capabilities. */
  get capabilities() {
    return buildCapabilities({
      unixSocket: true,
      tlsClientCert: true,
      requestCompression: true,
      responseStreaming: true,
      requestStreaming: true,
      keepAlive: true,
      abort: true
    })
  }

  /** @returns {Promise<{http: any, https: any, zlib: any, stream: any}>} - Lazily-loaded Node modules. */
  async _load() {
    if (!this._modules) {
      const [http, https, zlib, stream] = await Promise.all([
        import("node:http"),
        import("node:https"),
        import("node:zlib"),
        import("node:stream")
      ])

      this._modules = {http, https, zlib, stream}
    }

    return this._modules
  }

  /**
   * @param {boolean} useTls - Whether the request uses TLS.
   * @returns {any} - The keep-alive agent for the protocol.
   */
  _agent(useTls) {
    const {http, https} = /** @type {{http: any, https: any}} */ (this._modules)

    if (useTls) {
      this._httpsAgent ||= new https.Agent({
        keepAlive: this.keepAlive,
        ...(this.tls?.ca !== undefined ? {ca: this.tls.ca} : {}),
        ...(this.tls?.cert !== undefined ? {cert: this.tls.cert} : {}),
        ...(this.tls?.key !== undefined ? {key: this.tls.key} : {}),
        ...(this.tls?.rejectUnauthorized !== undefined ? {rejectUnauthorized: this.tls.rejectUnauthorized} : {})
      })

      return this._httpsAgent
    }

    this._httpAgent ||= new http.Agent({keepAlive: this.keepAlive})

    return this._httpAgent
  }

  /**
   * Performs a single request and resolves once the response headers arrive,
   * exposing the (decoded) body as a stream so callers can buffer or stream it.
   * @param {import("../snap-req.js").NormalizedRequest} request - Normalized request.
   * @returns {Promise<SnapReqResponse>} - The response.
   */
  async performRequest(request) {
    const modules = await this._load()
    const {zlib, stream} = modules
    const parsedUrl = new URL(request.url)
    const useTls = Boolean(this.tls) || parsedUrl.protocol === "https:"
    const httpModule = useTls ? modules.https : modules.http
    const headers = new SnapReqHeaders(request.headers)
    const requestBody = this._prepareRequestBody(request, headers, {zlib, stream})

    /** @type {Record<string, any>} */
    const requestOptions = {
      method: request.method,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: headers.toObject(),
      agent: this._agent(useTls)
    }

    if (this.socketPath) {
      requestOptions.socketPath = this.socketPath
    } else {
      requestOptions.hostname = parsedUrl.hostname
      requestOptions.port = parsedUrl.port || (useTls ? 443 : 80)
    }

    return await new Promise((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new SnapReqAbortError())
        return
      }

      let settled = false
      const abort = () => {
        const error = new SnapReqAbortError()

        requestBody.stream?.unpipe(req)
        if (requestBody.ownedStream) requestBody.stream?.destroy(error)
        req.destroy(error)
      }
      const removeAbortListener = () => request.signal?.removeEventListener("abort", abort)

      const req = httpModule.request(requestOptions, (res) => {
        /** @type {import("node:stream").Readable} */
        let responseStream

        try {
          responseStream = this._decodeResponseStream(res, zlib)
        } catch (error) {
          if (!settled) {
            settled = true
            removeAbortListener()
            reject(error)
          }

          return
        }

        // Re-point the abort listener at the response stream so aborting after
        // headers arrive tears down the body stream rather than the request.
        removeAbortListener()
        const cancelResponse = (/** @type {Error} */ error) => {
          responseStream.destroy(error)
          if (responseStream !== res) res.destroy(error)
        }
        const abortStream = () => cancelResponse(new SnapReqAbortError())

        request.signal?.addEventListener("abort", abortStream, {once: true})
        responseStream.on("close", () => request.signal?.removeEventListener("abort", abortStream))

        // Cancellation may own and destroy a response body before the caller
        // starts consuming it. Keep that intentional stream error from being
        // process-fatal; async iteration still observes and rejects with it.
        const handleOwnedResponseError = () => {}

        for (const ownedStream of new Set([res, responseStream])) {
          ownedStream.on("error", handleOwnedResponseError)
          ownedStream.once("close", () => ownedStream.removeListener("error", handleOwnedResponseError))
        }

        settled = true
        resolve(new SnapReqResponse({
          url: request.url,
          method: request.method,
          status: res.statusCode,
          statusText: res.statusMessage || "",
          headers: this._responseHeaders(res),
          stream: responseStream,
          nodeStream: responseStream,
          cancelBody: (error) => cancelResponse(/** @type {Error} */ (error))
        }))
      })

      request.signal?.addEventListener("abort", abort, {once: true})

      const onRequestBodyError = (/** @type {Error} */ error) => req.destroy(error)

      requestBody.stream?.on("error", onRequestBodyError)
      if (requestBody.ownedStream) {
        requestBody.stream?.once("close", () => requestBody.stream?.removeListener("error", onRequestBodyError))
      } else {
        req.on("close", () => requestBody.stream?.removeListener("error", onRequestBodyError))
      }

      req.on("error", (/** @type {unknown} */ error) => {
        removeAbortListener()

        if (!settled) {
          settled = true
          reject(error)
        }
      })

      if (requestBody.stream) {
        requestBody.stream.pipe(req)
      } else {
        if (requestBody.buffer) req.write(requestBody.buffer)

        req.end()
      }
    })
  }

  /**
   * @param {import("../snap-req.js").NormalizedRequest} request - Normalized request.
   * @param {SnapReqHeaders} headers - Headers, mutated with Content-Length / Content-Encoding.
   * @param {{zlib: any, stream: any}} modules - Node modules.
   * @returns {{buffer: Buffer | null, stream: import("node:stream").Readable | null, ownedStream: boolean}} - Prepared body.
   */
  _prepareRequestBody(request, headers, {zlib, stream}) {
    const compression = request.bodyCompression || "identity"
    const body = request.body

    if (body.kind === "none") return {buffer: null, stream: null, ownedStream: false}

    /** @type {Buffer | null} */
    let buffer = null
    /** @type {import("node:stream").Readable | null} */
    let bodyStream = null
    let ownedStream = false

    if (body.kind === "stream") {
      const value = /** @type {any} */ (body.value)

      ownedStream = typeof value.pipe !== "function"
      bodyStream = ownedStream ? stream.Readable.from(value) : value
    } else if (body.kind === "bytes") {
      buffer = Buffer.from(/** @type {Uint8Array} */ (body.value))
    } else {
      buffer = Buffer.from(/** @type {string} */ (body.value))
    }

    if (compression === "identity") {
      if (buffer) headers.set("Content-Length", String(buffer.length))

      return {buffer, stream: bodyStream, ownedStream}
    }

    if (headers.has("content-encoding")) {
      throw new SnapReqUnsupportedFeatureError({
        feature: "bodyCompression",
        transport: "node",
        detail: "cannot combine bodyCompression with an explicit Content-Encoding header"
      })
    }

    headers.set("Content-Encoding", compression)

    const compressor = this._requestCompressor(compression, zlib)
    const source = bodyStream || stream.Readable.from(/** @type {Buffer} */ (buffer))

    const forwardError = (/** @type {Error} */ error) => compressor.destroy(error)

    source.on("error", forwardError)
    compressor.once("close", () => {
      source.unpipe(compressor)
      source.removeListener("error", forwardError)
    })
    source.pipe(compressor)

    return {buffer: null, stream: compressor, ownedStream: true}
  }

  /**
   * @param {string} encoding - Compression encoding.
   * @param {any} zlib - The zlib module.
   * @returns {import("node:stream").Transform} - A compressor transform.
   */
  _requestCompressor(encoding, zlib) {
    if (encoding === "gzip") return zlib.createGzip()
    if (encoding === "deflate") return zlib.createDeflate()
    if (encoding === "br") return zlib.createBrotliCompress()
    if (encoding === "zstd" && typeof zlib.createZstdCompress === "function") return zlib.createZstdCompress()

    throw new SnapReqUnsupportedFeatureError({feature: `bodyCompression "${encoding}"`, transport: "node"})
  }

  /**
   * @param {import("node:http").IncomingMessage} response - The raw response.
   * @param {any} zlib - The zlib module.
   * @returns {import("node:stream").Readable} - The decoded response body stream.
   */
  _decodeResponseStream(response, zlib) {
    const header = response.headers["content-encoding"]
    const headerValue = Array.isArray(header) ? header.join(",") : header
    const encodings = (headerValue || "")
      .split(",")
      .map((encoding) => encoding.trim().toLowerCase())
      .filter((encoding) => encoding && encoding !== "identity")

    /** @type {import("node:stream").Readable} */
    let decoded = response

    for (let index = encodings.length - 1; index >= 0; index -= 1) {
      decoded = decoded.pipe(this._responseDecoder(encodings[index], zlib))
    }

    return decoded
  }

  /**
   * @param {string} encoding - Content encoding.
   * @param {any} zlib - The zlib module.
   * @returns {import("node:stream").Transform} - A decompressor transform.
   */
  _responseDecoder(encoding, zlib) {
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip()
    if (encoding === "deflate") return zlib.createInflate()
    if (encoding === "br") return zlib.createBrotliDecompress()
    if (encoding === "zstd" && typeof zlib.createZstdDecompress === "function") return zlib.createZstdDecompress()

    throw new SnapReqUnsupportedFeatureError({feature: `response content-encoding "${encoding}"`, transport: "node"})
  }

  /**
   * @param {import("node:http").IncomingMessage} response - The raw response.
   * @returns {SnapReqHeaders} - The response headers.
   */
  _responseHeaders(response) {
    const headers = new SnapReqHeaders()

    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue

      headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }

    return headers
  }

  /**
   * Destroys the keep-alive agents, closing all persistent connections.
   * @returns {void}
   */
  close() {
    this._httpAgent?.destroy()
    this._httpsAgent?.destroy()
    this._httpAgent = null
    this._httpsAgent = null
  }
}
