// @ts-check

import {describe, it} from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import SnapReq from "../src/snap-req.js"
import ProxyBounceTransport from "../src/transports/proxy-bounce-transport.js"

/**
 * Starts a small HTTP server that simulates the backend proxy endpoint: it
 * receives a POST with `{method, url, headers, body}` and returns a
 * proxy-style JSON response `{status, headers, body: base64}`.
 * @param {object} [options] - Server options.
 * @param {(payload: Record<string, any>) => Promise<{status: number, statusText?: string, headers?: Record<string, string>, body: Uint8Array} | null>} [options.handler] - Custom handler; receives the deserialized proxy payload and should return a raw response or null to use the default below.
 * @param {Record<string, string>} [options.responseHeaders] - Headers in the proxy JSON reply.
 * @param {number} [options.status] - HTTP status code in the proxy JSON reply.
 * @param {Uint8Array} [options.body] - Body bytes for the proxy JSON reply.
 * @returns {Promise<{port: number, payloads: Record<string, any>[], close: () => Promise<void>}>} - Server handle.
 */
async function startMockProxy(options = {}) {
  const {handler, responseHeaders = {"Content-Type": "application/json"}, status = 200, body = new TextEncoder().encode("{}")} = options

  /** @type {Record<string, any>[]} */
  const payloads = []

  const server = http.createServer(async (req, res) => {
    /** @type {Buffer[]} */
    const chunks = []

    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", async () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"))

      payloads.push(payload)

      if (handler) {
        const result = await handler(payload)

        if (result) {
          const encoded = Buffer.from(result.body).toString("base64")

          res.writeHead(200, {"Content-Type": "application/json"})
          res.end(JSON.stringify({
            body: encoded,
            headers: result.headers || {},
            status: result.status,
            statusText: result.statusText || ""
          }))

          return
        }
      }

      const encoded = Buffer.from(body).toString("base64")

      res.writeHead(200, {"Content-Type": "application/json"})
      res.end(JSON.stringify({body: encoded, headers: responseHeaders, status, statusText: String(status)}))
    })
  })

  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", () => resolveStart(null)))

  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Failed to bind mock proxy server")

  return {
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
    payloads,
    port: address.port
  }
}

describe("ProxyBounceTransport", () => {
  it("has transportName", () => {
    assert.equal(ProxyBounceTransport.transportName, "proxy-bounce")
  })

  it("reports abort capability", () => {
    const transport = new ProxyBounceTransport({proxyUrl: "http://localhost/proxy"})

    assert.equal(transport.capabilities.abort, true)
    assert.equal(transport.capabilities.responseStreaming, false)
  })

  it("performs a GET through the mock proxy", async () => {
    const proxy = await startMockProxy({
      body: new TextEncoder().encode(JSON.stringify({ok: true}))
    })

    try {
      const client = new SnapReq({
        baseUrl: "http://example.com",
        transport: new ProxyBounceTransport({proxyUrl: `http://127.0.0.1:${proxy.port}/api/proxy`})
      })

      const response = await client.get("/ping")

      assert.equal(response.status, 200)
      assert.equal(response.ok, true)
      assert.deepEqual(await response.json(), {ok: true})

      assert.equal(proxy.payloads.length, 1)
      assert.equal(proxy.payloads[0].method, "GET")
      assert.equal(proxy.payloads[0].url, "http://example.com/ping")

      client.close()
    } finally {
      await proxy.close()
    }
  })

  it("sends merged headers to the proxy", async () => {
    const proxy = await startMockProxy()

    try {
      const client = new SnapReq({
        baseUrl: "http://example.com",
        headers: {"X-Custom": "hello"},
        transport: new ProxyBounceTransport({proxyUrl: `http://127.0.0.1:${proxy.port}/api/proxy`})
      })

      await client.get("/test", {headers: {"X-Request": "world"}})

      assert.equal(proxy.payloads.length, 1)
      assert.equal(proxy.payloads[0].headers["X-Custom"], "hello")
      assert.equal(proxy.payloads[0].headers["X-Request"], "world")

      client.close()
    } finally {
      await proxy.close()
    }
  })

  it("returns a non-2xx proxied response correctly", async () => {
    const proxy = await startMockProxy({
      body: new TextEncoder().encode(JSON.stringify({error: "not found"})),
      responseHeaders: {"Content-Type": "application/json"},
      status: 404
    })

    try {
      const client = new SnapReq({
        baseUrl: "http://example.com",
        transport: new ProxyBounceTransport({proxyUrl: `http://127.0.0.1:${proxy.port}/api/proxy`})
      })

      const response = await client.get("/missing")

      assert.equal(response.status, 404)
      assert.equal(response.ok, false)
      assert.deepEqual(await response.json(), {error: "not found"})

      client.close()
    } finally {
      await proxy.close()
    }
  })

  it("exposes buffered proxied responses as readable streams", async () => {
    const proxy = await startMockProxy({
      body: new TextEncoder().encode("data: {\"delta\":\"hello\"}\n\ndata: [DONE]\n\n"),
      responseHeaders: {"Content-Type": "text/event-stream"}
    })

    try {
      const client = new SnapReq({
        baseUrl: "http://example.com",
        transport: new ProxyBounceTransport({proxyUrl: `http://127.0.0.1:${proxy.port}/api/proxy`})
      })

      const response = await client.get("/stream")
      const decoder = new TextDecoder()
      let text = ""

      assert.equal(response.headers.get("content-type"), "text/event-stream")
      assert.equal(response.streamable, true)

      for await (const chunk of response.stream()) {
        text += decoder.decode(chunk, {stream: true})
      }

      text += decoder.decode()

      assert.equal(text, "data: {\"delta\":\"hello\"}\n\ndata: [DONE]\n\n")
      assert.equal(response.streamable, false)

      client.close()
    } finally {
      await proxy.close()
    }
  })
})
