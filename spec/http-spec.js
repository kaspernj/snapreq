// @ts-check

import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {Readable} from "node:stream"
import SnapReq from "../src/snap-req.js"
import {SnapReqHttpError, SnapReqTimeoutError, SnapReqUnsupportedFeatureError} from "../src/errors.js"
import SnapReqResponse from "../src/response.js"
import {startTestServer} from "./support/test-server.js"

/** @type {Awaited<ReturnType<typeof startTestServer>>} */
let server

before(async () => {
  server = await startTestServer()
})

after(async () => {
  await server.close()
})

// The same behavioural suite runs against both transports so the cross-platform
// contract is verified, not just the Node-specific path.
for (const transport of ["node", "fetch"]) {
  describe(`SnapReq over the ${transport} transport`, () => {
    /** @returns {SnapReq} */
    const newClient = (config = {}) => new SnapReq({baseUrl: server.baseUrl, transport: /** @type {any} */ (transport), ...config})

    it("performs a GET and parses JSON", async () => {
      const client = newClient()
      const response = await client.get("/json", {query: {a: "1"}})

      assert.equal(response.status, 200)
      assert.equal(response.ok, true)
      assert.deepEqual(await response.json(), {ok: true, query: {a: "1"}})

      client.close()
    })

    it("sends a JSON body and default content type on POST", async () => {
      const client = newClient()
      const response = await client.post("/echo", {hello: "world"})
      const json = await response.json()

      assert.equal(json.method, "POST")
      assert.equal(json.contentType, "application/json")
      assert.equal(json.body, "{\"hello\":\"world\"}")

      client.close()
    })

    it("merges default and per-request headers", async () => {
      const client = newClient({headers: {"X-Default": "yes"}})
      const response = await client.get("/headers", {headers: {"X-Request": "also"}})
      const headers = await response.json()

      assert.equal(headers["x-default"], "yes")
      assert.equal(headers["x-request"], "also")

      client.close()
    })

    it("does not throw on non-2xx by default but exposes the status", async () => {
      const client = newClient()
      const response = await client.get("/status/404")

      assert.equal(response.status, 404)
      assert.equal(response.ok, false)

      client.close()
    })

    it("throws SnapReqHttpError when throwOnError is set", async () => {
      const client = newClient({throwOnError: true})

      await assert.rejects(
        () => client.get("/status/500"),
        (error) => {
          assert.ok(error instanceof SnapReqHttpError)
          assert.equal(error.status, 500)
          assert.match(error.message, /status 500/)
          return true
        }
      )

      client.close()
    })

    it("transparently decodes a gzip-encoded response", async () => {
      const client = newClient()
      const response = await client.get("/gzip")

      assert.equal(await response.text(), "compressed-hello")

      client.close()
    })

    it("retries retryable statuses until success", async () => {
      server.resetFlaky()
      const client = newClient()
      const response = await client.get("/flaky", {retry: {tries: 5, waitMs: 1}})

      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), {ok: true, attempts: 3})

      client.close()
    })

    it("times out before response headers arrive", async () => {
      const client = newClient({timeoutMs: 100})

      await assert.rejects(
        () => client.get("/slow-start"),
        (error) => {
          assert.ok(error instanceof SnapReqTimeoutError)
          assert.equal(error.method, "GET")
          assert.match(error.url, /\/slow-start$/)
          assert.equal(error.timeoutMs, 100)
          return true
        }
      )

      client.close()
    })

    it("times out while buffering the response body", async () => {
      const client = newClient()
      const response = await client.get("/slow-body", {timeoutMs: 100})

      await assert.rejects(
        () => response.text(),
        (error) => {
          assert.ok(error instanceof SnapReqTimeoutError)
          assert.match(error.url, /\/slow-body$/)
          return true
        }
      )

      client.close()
    })

    it("retries timed-out requests when retry is enabled", async () => {
      server.resetSlowFlaky()
      const client = newClient()
      const response = await client.get("/flaky-slow", {timeoutMs: 100, retry: {tries: 2, waitMs: 1}})

      assert.deepEqual(await response.json(), {ok: true, attempts: 2})

      client.close()
    })

    it("clears timeout timers for already-buffered transport responses", async () => {
      const originalSetTimeout = globalThis.setTimeout
      const originalClearTimeout = globalThis.clearTimeout
      /** @type {unknown[]} */
      const timers = []
      const clearedTimers = new Set()

      globalThis.setTimeout = (callback, delay, ...args) => {
        const timer = originalSetTimeout(callback, delay, ...args)

        timers.push(timer)

        return timer
      }
      globalThis.clearTimeout = (timer) => {
        clearedTimers.add(timer)

        return originalClearTimeout(timer)
      }

      const client = newClient({
        transport: {
          capabilities: {},
          performRequest: async (request) => new SnapReqResponse({
            url: request.url,
            method: request.method,
            status: 200,
            bytes: new TextEncoder().encode("buffered")
          })
        },
        timeoutMs: 100
      })

      try {
        const response = await client.get("/already-buffered")

        assert.equal(await response.text(), "buffered")
        assert.equal(clearedTimers.has(timers[0]), true)
      } finally {
        client.close()
        globalThis.setTimeout = originalSetTimeout
        globalThis.clearTimeout = originalClearTimeout
      }
    })

    it("streams a response body chunk by chunk", async () => {
      const client = newClient()
      const response = await client.requestStream({method: "GET", path: "/stream"})
      let collected = ""

      for await (const chunk of response.stream()) {
        collected += new TextDecoder().decode(chunk)
      }

      assert.equal(collected, "chunk-1;chunk-2;chunk-3")

      client.close()
    })
  })
}

describe("SnapReq node-only features", () => {
  it("compresses the request body with gzip", async () => {
    const client = new SnapReq({baseUrl: server.baseUrl, transport: "node"})
    const response = await client.post("/echo", "uncompressed-payload", {bodyCompression: "gzip"})
    const json = await response.json()

    assert.equal(json.contentEncoding, "gzip")
    assert.equal(json.body, "uncompressed-payload")

    client.close()
  })

  it("sends a streamed request body", async () => {
    const client = new SnapReq({baseUrl: server.baseUrl, transport: "node"})
    const response = await client.post("/echo", Readable.from(["strea", "med-", "body"]))
    const json = await response.json()

    assert.equal(json.body, "streamed-body")

    client.close()
  })
})

describe("SnapReq fetch transport limitations", () => {
  it("rejects request body compression with a clear error", async () => {
    const client = new SnapReq({baseUrl: server.baseUrl, transport: "fetch"})

    await assert.rejects(
      () => client.post("/echo", "x", {bodyCompression: "gzip"}),
      (error) => {
        assert.ok(error instanceof SnapReqUnsupportedFeatureError)
        assert.equal(error.feature, "request body compression")
        return true
      }
    )

    client.close()
  })
})
