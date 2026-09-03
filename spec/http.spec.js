// @ts-check

import {afterAll, beforeAll, describe, expect, it} from "@velocious/testing"
import {spawn} from "node:child_process"
import {PassThrough, Readable} from "node:stream"
import SnapReq from "../src/snap-req.js"
import {SnapReqAbortError, SnapReqHttpError, SnapReqTimeoutError, SnapReqUnsupportedFeatureError} from "../src/errors.js"
import SnapReqResponse from "../src/response.js"
import FetchTransport from "../src/transports/fetch-transport.js"
import {startTestServer} from "./support/test-server.js"

describe("SnapReq HTTP", () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
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

        expect(response.status).toBe(200)
        expect(response.ok).toBe(true)
        expect(await response.json()).toEqual({ok: true, query: {a: "1"}})

        client.close()
      })

      it("sends a JSON body and default content type on POST", async () => {
        const client = newClient()
        const response = await client.post("/echo", {hello: "world"})
        const json = await response.json()

        expect(json.method).toBe("POST")
        expect(json.contentType).toBe("application/json")
        expect(json.body).toBe("{\"hello\":\"world\"}")

        client.close()
      })

      it("merges default and per-request headers", async () => {
        const client = newClient({headers: {"X-Default": "yes"}})
        const response = await client.get("/headers", {headers: {"X-Request": "also"}})
        const headers = await response.json()

        expect(headers["x-default"]).toBe("yes")
        expect(headers["x-request"]).toBe("also")

        client.close()
      })

      it("does not throw on non-2xx by default but exposes the status", async () => {
        const client = newClient()
        const response = await client.get("/status/404")

        expect(response.status).toBe(404)
        expect(response.ok).toBe(false)

        client.close()
      })

      it("throws SnapReqHttpError when throwOnError is set", async () => {
        const client = newClient({throwOnError: true})

        /** @type {unknown} */
        let requestError

        try {
          await client.get("/status/500")
        } catch (error) {
          requestError = error
        }

        expect(requestError).toBeInstanceOf(SnapReqHttpError)

        const httpError = /** @type {SnapReqHttpError} */ (requestError)

        expect(httpError.status).toBe(500)
        expect(httpError.message).toMatch(/status 500/)

        client.close()
      })

      it("transparently decodes a gzip-encoded response", async () => {
        const client = newClient()
        const response = await client.get("/gzip")

        expect(await response.text()).toBe("compressed-hello")

        client.close()
      })

      it("retries retryable statuses until success", async () => {
        server.resetFlaky()
        const client = newClient()
        const response = await client.get("/flaky", {retry: {tries: 5, waitMs: 1}})

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ok: true, attempts: 3})

        client.close()
      })

      it("times out before response headers arrive", async () => {
        const client = newClient({timeoutMs: 100})

        /** @type {unknown} */
        let requestError

        try {
          await client.get("/slow-start")
        } catch (error) {
          requestError = error
        }

        expect(requestError).toBeInstanceOf(SnapReqTimeoutError)

        const timeoutError = /** @type {SnapReqTimeoutError} */ (requestError)

        expect(timeoutError.method).toBe("GET")
        expect(timeoutError.url).toMatch(/\/slow-start$/)
        expect(timeoutError.timeoutMs).toBe(100)

        client.close()
      })

      it("times out while buffering the response body", async () => {
        const client = newClient()
        const response = await client.get("/slow-body", {timeoutMs: 100})

        if (transport === "node") {
          expect(response.nodeStream?.rawListeners("error").some((listener) => listener.name === "handleOwnedResponseError")).toBe(true)
        }

        /** @type {unknown} */
        let responseError

        try {
          await response.text()
        } catch (error) {
          responseError = error
        }

        expect(responseError).toBeInstanceOf(SnapReqTimeoutError)

        const timeoutError = /** @type {SnapReqTimeoutError} */ (responseError)

        expect(timeoutError.url).toMatch(/\/slow-body$/)

        if (transport === "node") {
          expect(response.nodeStream?.rawListeners("error").some((listener) => listener.name === "handleOwnedResponseError")).toBe(false)
        }

        client.close()
      })

      it("retries timed-out requests when retry is enabled", async () => {
        server.resetSlowFlaky()
        const client = newClient()
        const response = await client.get("/flaky-slow", {timeoutMs: 100, retry: {tries: 2, waitMs: 1}})

        expect(await response.json()).toEqual({ok: true, attempts: 2})

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

          expect(await response.text()).toBe("buffered")
          expect(clearedTimers.has(timers[0])).toBe(true)
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

        expect(collected).toBe("chunk-1;chunk-2;chunk-3")

        client.close()
      })
    })
  }

  describe("SnapReq cancellation", () => {
    it("aborts bodyless fetch response buffering when the body deadline expires", async () => {
      const originalFetch = globalThis.fetch
      let fetchSignal
      let bodyAbortReason

      globalThis.fetch = async (_url, init) => {
        fetchSignal = init?.signal

        return /** @type {Response} */ (/** @type {unknown} */ ({
          arrayBuffer: () => new Promise((resolve, reject) => {
            fetchSignal?.addEventListener("abort", () => {
              bodyAbortReason = fetchSignal.reason
              reject(fetchSignal.reason)
            }, {once: true})
          }),
          body: null,
          headers: {forEach: () => {}},
          status: 200,
          statusText: "OK"
        }))
      }

      const client = new SnapReq({transport: new FetchTransport()})

      try {
        const response = await client.get("https://example.test/bodyless", {timeoutMs: 20})

        await expect(() => response.text()).toThrow(SnapReqTimeoutError)
        expect(bodyAbortReason).toBeInstanceOf(SnapReqTimeoutError)
      } finally {
        client.close()
        globalThis.fetch = originalFetch
      }
    })

    it("tears down an unconsumed Node response deadline without an uncaught stream error", async () => {
      const child = spawn(process.execPath, [new URL("./support/unconsumed-response-child.js", import.meta.url).pathname], {
        stdio: ["ignore", "pipe", "pipe"]
      })
      let stdout = ""
      let stderr = ""

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })

      const result = await Promise.race([
        new Promise((resolve) => child.once("exit", (code, signal) => resolve({code, signal}))),
        new Promise((_, reject) => setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error("unconsumed response child did not exit"))
        }, 2000))
      ])

      expect({result, stderr}).toEqual({result: {code: 0, signal: null}, stderr})
      expect(JSON.parse(stdout)).toEqual({
        uncaught: [],
        responseClosed: true,
        socketClosed: true
      })
    })

    for (const tries of [1, 3]) {
      it(`keeps the final retryable response body readable after ${tries} ${tries === 1 ? "try" : "tries"}`, async () => {
        let attempts = 0
        const cancelledAttempts = []
        const client = new SnapReq({
          transport: {
            capabilities: {},
            performRequest: async (request) => {
              attempts += 1
              const attemptNumber = attempts

              if (attemptNumber > 1) {
                expect(cancelledAttempts).toEqual(Array.from({length: attemptNumber - 1}, (_, index) => index + 1))
              }

              return new SnapReqResponse({
                url: request.url,
                method: request.method,
                status: 503,
                stream: Readable.from([new TextEncoder().encode(`retry body ${attemptNumber}`)]),
                cancelBody: () => cancelledAttempts.push(attemptNumber)
              })
            }
          }
        })

        const response = await client.get("http://example.test/exhausted", {
          retry: {tries, waitMs: 1}
        })

        expect(response.status).toBe(503)
        expect(await response.text()).toBe(`retry body ${tries}`)
        expect(attempts).toBe(tries)
        expect(cancelledAttempts).toEqual(Array.from({length: tries - 1}, (_, index) => index + 1))
        client.close()
      })
    }

    it("clears intermediate retry body watchdogs while leaving the exhausted body readable", async () => {
      const responses = []
      let attempts = 0

      const client = new SnapReq({
        transport: {
          capabilities: {},
          performRequest: async (request) => {
            attempts += 1
            const response = new SnapReqResponse({
              url: request.url,
              method: request.method,
              status: 503,
              stream: Readable.from([new TextEncoder().encode(`retry body ${attempts}`)]),
              cancelBody: () => {}
            })
            responses.push(response)
            return response
          }
        }
      })

      try {
        const response = await client.get("http://example.test/exhausted-with-timeout", {
          timeoutMs: 1000,
          retry: {tries: 3, waitMs: 1}
        })

        expect(responses.length).toBe(3)
        expect(responses[0]._bodyDone).toBe(true)
        expect(responses[1]._bodyDone).toBe(true)
        expect(responses[2]._bodyDone).toBe(false)
        expect(await response.text()).toBe("retry body 3")
        expect(responses[2]._bodyDone).toBe(true)
      } finally {
        client.close()
      }
    })

    it("passes 1-based try numbers to custom shouldRetry", async () => {
      const tryNumbers = []
      let attempts = 0
      const client = new SnapReq({
        transport: {
          capabilities: {},
          performRequest: async () => {
            attempts += 1
            throw Object.assign(new Error("socket reset"), {code: "ECONNRESET"})
          }
        }
      })

      await expect(() => client.get("http://example.test/retry-numbering", {
        retry: {
          tries: 3,
          waitMs: 1,
          shouldRetry: (_error, tryNumber) => {
            tryNumbers.push(tryNumber)
            return true
          }
        }
      })).toThrow(/socket reset/)

      expect(attempts).toBe(3)
      expect(tryNumbers).toEqual([1, 2])
      client.close()
    })

    for (const transport of ["node", "fetch"]) {
      it(`maps caller cancellation before headers over ${transport}`, async () => {
        const controller = new AbortController()
        const client = new SnapReq({baseUrl: server.baseUrl, transport: /** @type {any} */ (transport)})
        const request = client.get("/slow-start", {signal: controller.signal})

        controller.abort()
        await expect(() => request).toThrow(SnapReqAbortError)
        client.close()
      })

      for (const timeoutMs of [undefined, 1000]) {
        it(`cancels response buffering after headers over ${transport}${timeoutMs ? " with a deadline" : ""}`, async () => {
          const controller = new AbortController()
          const client = new SnapReq({baseUrl: server.baseUrl, transport: /** @type {any} */ (transport)})
          const response = await client.get("/slow-body", {signal: controller.signal, timeoutMs})
          const body = response.text()

          controller.abort()
          await expect(() => body).toThrow(SnapReqAbortError)
          client.close()
        })
      }

      it(`keeps a completed body terminal when the caller later aborts over ${transport}`, async () => {
        const controller = new AbortController()
        const client = new SnapReq({baseUrl: server.baseUrl, transport: /** @type {any} */ (transport)})
        const response = await client.get("/json", {signal: controller.signal, timeoutMs: 1000})
        const body = await response.text()

        controller.abort()
        expect(await response.text()).toBe(body)
        client.close()
      })
    }

    it("interrupts a retry wait without starting another attempt", async () => {
      const controller = new AbortController()
      let attempts = 0
      const client = new SnapReq({
        transport: {
          capabilities: {},
          performRequest: async () => {
            attempts += 1

            if (attempts > 1) throw new Error("request attempted after cancellation")

            throw Object.assign(new Error("socket reset"), {code: "ECONNRESET"})
          }
        }
      })

      await expect(
        () => client.get("http://example.test/retry", {
          signal: controller.signal,
          retry: {
            tries: 3,
            waitMs: 1,
            shouldRetry: () => {
              controller.abort()
              return true
            }
          }
        })
      ).toThrow(SnapReqAbortError)
      expect(attempts).toBe(1)
    })
  })

  describe("SnapReq node-only features", () => {
    it("tears down a compressed upload without destroying the caller stream", async () => {
      const source = new PassThrough()
      const client = new SnapReq({baseUrl: server.baseUrl, transport: "node"})

      source.write("partial")
      await expect(
        () => client.post("/echo", source, {bodyCompression: "gzip", timeoutMs: 20})
      ).toThrow(SnapReqTimeoutError)
      expect(source.destroyed).toBe(false)
      source.destroy()
      client.close()
    })

    it("compresses the request body with gzip", async () => {
      const client = new SnapReq({baseUrl: server.baseUrl, transport: "node"})
      const response = await client.post("/echo", "uncompressed-payload", {bodyCompression: "gzip"})
      const json = await response.json()

      expect(json.contentEncoding).toBe("gzip")
      expect(json.body).toBe("uncompressed-payload")

      client.close()
    })

    it("sends a streamed request body", async () => {
      const client = new SnapReq({baseUrl: server.baseUrl, transport: "node"})
      const response = await client.post("/echo", Readable.from(["strea", "med-", "body"]))
      const json = await response.json()

      expect(json.body).toBe("streamed-body")

      client.close()
    })
  })

  describe("SnapReq fetch transport limitations", () => {
    it("rejects request body compression with a clear error", async () => {
      const client = new SnapReq({baseUrl: server.baseUrl, transport: "fetch"})

      /** @type {unknown} */
      let requestError

      try {
        await client.post("/echo", "x", {bodyCompression: "gzip"})
      } catch (error) {
        requestError = error
      }

      expect(requestError).toBeInstanceOf(SnapReqUnsupportedFeatureError)

      const unsupportedFeatureError = /** @type {SnapReqUnsupportedFeatureError} */ (requestError)

      expect(unsupportedFeatureError.feature).toBe("request body compression")

      client.close()
    })
  })
})
