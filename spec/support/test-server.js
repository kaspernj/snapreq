// @ts-check

import http from "node:http"
import zlib from "node:zlib"

/**
 * Decompresses a request body buffer according to a Content-Encoding header.
 * @param {Buffer} body - The raw request body.
 * @param {string | undefined} encoding - The Content-Encoding header value.
 * @returns {Buffer} - The decoded body.
 */
function decodeBody(body, encoding) {
  if (!encoding || encoding === "identity") return body
  if (encoding === "gzip") return zlib.gunzipSync(body)
  if (encoding === "deflate") return zlib.inflateSync(body)
  if (encoding === "br") return zlib.brotliDecompressSync(body)

  throw new Error(`Unsupported request encoding in test server: ${encoding}`)
}

/**
 * Starts a small HTTP server exposing fixed routes used by the HTTP specs.
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>, flakyCalls: () => number, resetFlaky: () => void, resetSlowFlaky: () => void}>} - Server handle.
 */
export async function startTestServer() {
  let flakyCalls = 0
  let slowFlakyCalls = 0

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost")
    /** @type {Buffer[]} */
    const chunks = []

    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"])

      if (url.pathname === "/json") {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({ok: true, query: Object.fromEntries(url.searchParams)}))
      } else if (url.pathname === "/echo") {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({
          method: req.method,
          contentType: req.headers["content-type"] || null,
          contentEncoding: req.headers["content-encoding"] || null,
          body: body.toString("utf-8")
        }))
      } else if (url.pathname === "/headers") {
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(req.headers))
      } else if (url.pathname.startsWith("/status/")) {
        const status = Number(url.pathname.split("/")[2])

        res.writeHead(status, {"Content-Type": "application/json"})
        res.end(JSON.stringify({message: `status ${status}`}))
      } else if (url.pathname === "/gzip") {
        res.writeHead(200, {"Content-Type": "text/plain", "Content-Encoding": "gzip"})
        res.end(zlib.gzipSync(Buffer.from("compressed-hello")))
      } else if (url.pathname === "/stream") {
        res.writeHead(200, {"Content-Type": "text/plain"})
        res.write("chunk-1;")
        setTimeout(() => {
          res.write("chunk-2;")
          setTimeout(() => res.end("chunk-3"), 10)
        }, 10)
      } else if (url.pathname === "/slow-start") {
        // Intentionally never respond, simulating a stalled upstream.
      } else if (url.pathname === "/slow-body") {
        res.writeHead(200, {"Content-Type": "text/plain"})
        res.write("partial")
      } else if (url.pathname === "/flaky-slow") {
        slowFlakyCalls += 1

        if (slowFlakyCalls === 1) return

        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify({ok: true, attempts: slowFlakyCalls}))
      } else if (url.pathname === "/flaky") {
        flakyCalls += 1

        if (flakyCalls < 3) {
          res.writeHead(503, {"Content-Type": "application/json"})
          res.end(JSON.stringify({message: "try again"}))
        } else {
          res.writeHead(200, {"Content-Type": "application/json"})
          res.end(JSON.stringify({ok: true, attempts: flakyCalls}))
        }
      } else {
        res.writeHead(404, {"Content-Type": "application/json"})
        res.end(JSON.stringify({message: "not found"}))
      }
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(null)))

  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Failed to bind test server")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    flakyCalls: () => flakyCalls,
    resetFlaky: () => {
      flakyCalls = 0
    },
    resetSlowFlaky: () => {
      slowFlakyCalls = 0
    }
  }
}
