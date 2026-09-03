// @ts-check

import {describe, expect, it} from "@velocious/testing"
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
    expect(ProxyBounceTransport.transportName).toBe("proxy-bounce")
  })

  it("reports abort capability", () => {
    const transport = new ProxyBounceTransport({proxyUrl: "http://localhost/proxy"})

    expect(transport.capabilities.abort).toBe(true)
    expect(transport.capabilities.responseStreaming).toBe(false)
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

      expect(response.status).toBe(200)
      expect(response.ok).toBe(true)
      expect(await response.json()).toEqual({ok: true})

      expect(proxy.payloads.length).toBe(1)
      expect(proxy.payloads[0].method).toBe("GET")
      expect(proxy.payloads[0].url).toBe("http://example.com/ping")

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

      expect(proxy.payloads.length).toBe(1)
      expect(proxy.payloads[0].headers["X-Custom"]).toBe("hello")
      expect(proxy.payloads[0].headers["X-Request"]).toBe("world")

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

      expect(response.status).toBe(404)
      expect(response.ok).toBe(false)
      expect(await response.json()).toEqual({error: "not found"})

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

      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.streamable).toBe(true)

      for await (const chunk of response.stream()) {
        text += decoder.decode(chunk, {stream: true})
      }

      text += decoder.decode()

      expect(text).toBe("data: {\"delta\":\"hello\"}\n\ndata: [DONE]\n\n")
      expect(response.streamable).toBe(false)

      client.close()
    } finally {
      await proxy.close()
    }
  })
})
