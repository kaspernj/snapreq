// @ts-check

import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {Readable} from "node:stream"
import SnapReq from "../src/snap-req.js"
import {SnapReqHttpError, SnapReqUnsupportedFeatureError} from "../src/errors.js"
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
