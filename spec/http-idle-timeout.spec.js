// @ts-check

import {afterAll, beforeAll, describe, expect, it} from "@velocious/testing"
import http from "node:http"
import {PassThrough, Readable} from "node:stream"
import * as stream from "node:stream"
import {HttpRequestControl} from "../src/control.js"
import {SnapReqAbortError, SnapReqIdleTimeoutError, SnapReqTimeoutError, SnapReqUnsupportedFeatureError} from "../src/errors.js"
import SnapReq from "../src/snap-req.js"
import FetchTransport from "../src/transports/fetch-transport.js"
import NodeTransport from "../src/transports/node-transport.js"

const delay = (/** @type {number} */ milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** @returns {AsyncIterable<Uint8Array>} - A request body that remains active beyond the idle threshold. */
async function* progressingRequestBody() {
  for (let index = 0; index < 25; index += 1) {
    await delay(10)
    yield new TextEncoder().encode("x")
  }
}

describe("SnapReq HTTP idle timeout", () => {
  /** @type {import("node:http").Server} */
  let server
  let baseUrl

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://localhost")

      if (url.pathname === "/progressing-response") {
        response.writeHead(200, {"Content-Type": "text/plain"})
        let chunks = 0
        const interval = setInterval(() => {
          chunks += 1
          response.write("x")

          if (chunks === 25) {
            clearInterval(interval)
            response.end()
          }
        }, 10)

        response.once("close", () => clearInterval(interval))
        return
      }

      if (url.pathname === "/stalled-response") {
        response.writeHead(200, {"Content-Type": "text/plain"})
        response.write("partial")
        return
      }

      if (url.pathname === "/stalled-headers") return

      if (url.pathname === "/invalid-gzip") {
        response.writeHead(200, {"Content-Encoding": "gzip", "Content-Type": "text/plain"})
        response.end("not-gzip")
        return
      }

      if (url.pathname === "/premature-response") {
        response.writeHead(200, {"Connection": "close", "Content-Length": "20", "Content-Type": "text/plain"})
        response.end("partial")
        return
      }

      const chunks = []

      request.on("data", (chunk) => chunks.push(chunk))
      request.on("end", () => {
        response.writeHead(200, {"Content-Type": "text/plain"})
        response.end(String(Buffer.concat(chunks).byteLength))
      })
    })

    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)))

    const address = server.address()

    if (!address || typeof address === "string") throw new Error("Failed to bind idle-timeout test server")

    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  })

  it("resets one deterministic idle watchdog and ignores stale or late timer events", () => {
    let nextTimerId = 0
    const timers = new Map()
    const setTimeoutImplementation = (callback, milliseconds) => {
      nextTimerId += 1
      timers.set(nextTimerId, {callback, milliseconds})
      return nextTimerId
    }
    const clearTimeoutImplementation = (timerId) => timers.delete(timerId)
    const control = new HttpRequestControl({
      clearTimeoutImplementation,
      idleTimeoutMs: 100,
      method: "PUT",
      setTimeoutImplementation,
      timeoutMs: 500,
      url: "http://example.test/archive"
    })
    const initialTimers = [...timers.values()]
    const totalTimer = initialTimers.find((timer) => timer.milliseconds === 500)
    const staleIdleTimer = initialTimers.find((timer) => timer.milliseconds === 100)

    expect(totalTimer).toBeTruthy()
    expect(staleIdleTimer).toBeTruthy()

    control.progress("request_body")
    staleIdleTimer.callback()
    expect(control.signal.aborted).toBe(false)

    const activeIdleTimer = [...timers.values()].find((timer) => timer.milliseconds === 100)

    activeIdleTimer.callback()
    expect(control.signal.reason).toBeInstanceOf(SnapReqIdleTimeoutError)
    expect(control.signal.reason.phase).toBe("request_body")
    expect(timers.size).toBe(0)

    totalTimer.callback()
    control.finish()
    expect(control.signal.reason).toBeInstanceOf(SnapReqIdleTimeoutError)
  })

  it("cleans timers and the caller listener after successful settlement", () => {
    const caller = new AbortController()
    const timers = new Map()
    let nextTimerId = 0
    const control = new HttpRequestControl({
      clearTimeoutImplementation: (timerId) => timers.delete(timerId),
      idleTimeoutMs: 100,
      method: "GET",
      setTimeoutImplementation: (callback, milliseconds) => {
        nextTimerId += 1
        timers.set(nextTimerId, {callback, milliseconds})
        return nextTimerId
      },
      signal: caller.signal,
      timeoutMs: 500,
      url: "http://example.test/archive"
    })

    control.progress("response_body")
    control.finish()
    control.finish()
    caller.abort()

    expect(timers.size).toBe(0)
    expect(control.signal.aborted).toBe(false)
  })

  it("settles when a transport ignores cancellation before response headers", async () => {
    const timers = new Map()
    let nextTimerId = 0
    const control = new HttpRequestControl({
      clearTimeoutImplementation: (timerId) => timers.delete(timerId),
      idleTimeoutMs: 100,
      method: "GET",
      setTimeoutImplementation: (callback, milliseconds) => {
        nextTimerId += 1
        timers.set(nextTimerId, {callback, milliseconds})
        return nextTimerId
      },
      url: "http://example.test/archive"
    })
    const request = control.run(() => new Promise(() => {}))
    const idleTimer = [...timers.values()].find((timer) => timer.milliseconds === 100)

    idleTimer.callback()

    await expect(() => request).toThrow(SnapReqIdleTimeoutError)
    expect(timers.size).toBe(0)
  })

  it("does not schedule an omitted or explicitly disabled idle timeout", () => {
    let timers = 0
    const setTimeoutImplementation = () => {
      timers += 1
      return timers
    }

    for (const idleTimeoutMs of [undefined, 0]) {
      const control = new HttpRequestControl({
        idleTimeoutMs,
        method: "GET",
        setTimeoutImplementation,
        url: "http://example.test/archive"
      })

      control.finish()
    }

    expect(timers).toBe(0)
  })

  it("reports streamed upload progress only after the destination accepts a write", () => {
    let acceptWrite
    let finishWrite
    const phases = []
    const request = {
      end: (callback) => { finishWrite = callback },
      write: (_chunk, _encoding, callback) => {
        acceptWrite = callback
        return false
      }
    }
    const transport = new NodeTransport()
    const writer = transport._requestBodyWriter(
      /** @type {import("node:http").ClientRequest} */ (/** @type {unknown} */ (request)),
      (phase) => phases.push(phase),
      stream
    )
    const completed = new Promise((resolve, reject) => writer.end("chunk", (error) => error ? reject(error) : resolve(undefined)))

    expect(phases).toEqual([])
    acceptWrite()
    expect(phases).toEqual(["request_body"])
    finishWrite()

    return completed
  })

  for (const transport of ["node", "fetch"]) {
    it(`allows a progressing ${transport} response to exceed the idle threshold`, async () => {
      const client = new SnapReq({baseUrl, idleTimeoutMs: 100, timeoutMs: 0, transport: /** @type {any} */ (transport)})

      try {
        const response = await client.get("/progressing-response")

        expect((await response.text()).length).toBe(25)
      } finally {
        client.close()
      }
    })
  }

  it("rejects fetch request bodies when upload progress is unavailable", async () => {
    const client = new SnapReq({baseUrl, transport: "fetch"})

    try {
      await expect(
        () => client.post("/upload", "body", {idleTimeoutMs: 100, timeoutMs: 0})
      ).toThrow(SnapReqUnsupportedFeatureError)
    } finally {
      client.close()
    }
  })

  for (const {description, method, status} of [
    {description: "HEAD", method: "HEAD", status: 200},
    {description: "204", method: "GET", status: 204}
  ]) {
    it(`accepts a bodyless Fetch ${description} response with an idle timeout`, async () => {
      const originalFetch = globalThis.fetch
      const caller = new AbortController()
      /** @type {AbortSignal | undefined} */
      let fetchSignal

      globalThis.fetch = async (_url, init) => {
        fetchSignal = init?.signal

        return /** @type {Response} */ (/** @type {unknown} */ ({
          arrayBuffer: async () => { throw new Error("A semantic bodyless response must not be buffered") },
          body: null,
          headers: {forEach: () => {}},
          status,
          statusText: ""
        }))
      }

      const client = new SnapReq({idleTimeoutMs: 1000, timeoutMs: 0, transport: new FetchTransport()})

      try {
        const response = await client.request({method, path: "https://example.test/bodyless", signal: caller.signal})

        expect(response.status).toBe(status)
        expect((await response.bytes()).byteLength).toBe(0)

        caller.abort()
        expect(fetchSignal?.aborted).toBe(false)
      } finally {
        client.close()
        globalThis.fetch = originalFetch
      }
    })
  }

  it("streams an empty bodyless Fetch response through requestStream", async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async () => /** @type {Response} */ (/** @type {unknown} */ ({
      arrayBuffer: async () => { throw new Error("A semantic bodyless response must not be buffered") },
      body: null,
      headers: {forEach: () => {}},
      status: 204,
      statusText: "No Content"
    }))

    const client = new SnapReq({transport: new FetchTransport()})

    try {
      const response = await client.requestStream({method: "GET", path: "https://example.test/bodyless"})
      let streamedBytes = 0

      for await (const chunk of response.stream()) streamedBytes += chunk.byteLength

      expect(streamedBytes).toBe(0)
      expect(response.streamable).toBe(false)
    } finally {
      client.close()
      globalThis.fetch = originalFetch
    }
  })

  it("rejects a buffered non-bodyless Fetch response with an idle timeout", async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async () => /** @type {Response} */ (/** @type {unknown} */ ({
      arrayBuffer: async () => new ArrayBuffer(0),
      body: null,
      headers: {forEach: () => {}},
      status: 200,
      statusText: "OK"
    }))

    const client = new SnapReq({idleTimeoutMs: 1000, timeoutMs: 0, transport: new FetchTransport()})

    try {
      await expect(() => client.get("https://example.test/buffered")).toThrow(SnapReqUnsupportedFeatureError)
    } finally {
      client.close()
      globalThis.fetch = originalFetch
    }
  })

  it("preserves timeoutMs as an absolute deadline during response progress", async () => {
    const client = new SnapReq({baseUrl, transport: "node"})
    let requestError

    try {
      const response = await client.get("/progressing-response", {idleTimeoutMs: 500, timeoutMs: 100})

      await response.text()
    } catch (error) {
      requestError = error
    } finally {
      client.close()
    }

    expect(requestError).toBeInstanceOf(SnapReqTimeoutError)
    expect(requestError).not.toBeInstanceOf(SnapReqIdleTimeoutError)
    expect(requestError.timeoutKind).toBe("overall")
    expect(requestError.timeoutMs).toBe(100)
    expect(requestError.message).toMatch(/^Request timed out after 100ms: GET /)
  })

  it("classifies inactivity before response headers", async () => {
    const client = new SnapReq({baseUrl, transport: "node"})
    let requestError

    try {
      await client.get("/stalled-headers", {idleTimeoutMs: 40, timeoutMs: 0})
    } catch (error) {
      requestError = error
    } finally {
      client.close()
    }

    expect(requestError).toBeInstanceOf(SnapReqIdleTimeoutError)
    expect(requestError).toBeInstanceOf(SnapReqTimeoutError)
    expect(requestError.timeoutKind).toBe("idle")
    expect(requestError.timeoutMs).toBe(40)
    expect(requestError.idleTimeoutMs).toBe(40)
    expect(requestError.phase).toBe("connect_or_headers")
    expect(requestError.method).toBe("GET")
    expect(requestError.url).toMatch(/\/stalled-headers$/)
    expect(requestError.message).toMatch(/^Request made no progress for 40ms during connect_or_headers: GET /)
  })

  for (const transport of ["node", "fetch"]) {
    it(`classifies inactivity while reading a ${transport} response body`, async () => {
      const client = new SnapReq({baseUrl, transport: /** @type {any} */ (transport)})
      const response = await client.get("/stalled-response", {idleTimeoutMs: 40, timeoutMs: 0})
      let responseError

      try {
        await response.text()
      } catch (error) {
        responseError = error
      } finally {
        client.close()
      }

      expect(responseError).toBeInstanceOf(SnapReqIdleTimeoutError)
      expect(responseError.phase).toBe("response_body")

      if (transport === "node") expect(response.nodeStream?.destroyed).toBe(true)
    })
  }

  for (const path of ["/invalid-gzip", "/premature-response"]) {
    it(`reports the ${path.slice(1)} stream failure before the idle timeout`, async () => {
      const client = new SnapReq({baseUrl, transport: "node"})
      const response = await client.get(path, {idleTimeoutMs: 1000, timeoutMs: 0})
      let responseError

      try {
        await response.text()
      } catch (error) {
        responseError = error
      } finally {
        client.close()
      }

      expect(responseError).toBeInstanceOf(Error)
      expect(responseError).not.toBeInstanceOf(SnapReqTimeoutError)
      expect(response.nodeStream?.destroyed).toBe(true)

      if (path === "/premature-response") expect(responseError.code).toBe("ECONNRESET")
    })
  }

  it("allows an accepted streaming request body to exceed the idle threshold", async () => {
    const client = new SnapReq({baseUrl, transport: "node"})

    try {
      const response = await client.post("/upload", progressingRequestBody(), {idleTimeoutMs: 100, timeoutMs: 0})

      expect(await response.text()).toBe("25")
    } finally {
      client.close()
    }
  })

  it("times out a stalled streaming request body without destroying the caller stream", async () => {
    const source = new PassThrough()
    const client = new SnapReq({baseUrl, transport: "node"})

    source.write("partial")

    try {
      await expect(() => client.post("/upload", source, {idleTimeoutMs: 40, timeoutMs: 0})).toThrow(SnapReqIdleTimeoutError)
      expect(source.destroyed).toBe(false)
    } finally {
      source.destroy()
      client.close()
    }
  })

  it("preserves an original request-body stream error", async () => {
    const bodyError = new Error("request body failed")
    const source = Readable.from((async function* () {
      yield new TextEncoder().encode("partial")
      throw bodyError
    })())
    const client = new SnapReq({baseUrl, transport: "node"})
    let requestError

    try {
      await client.post("/upload", source, {idleTimeoutMs: 1000, timeoutMs: 0})
    } catch (error) {
      requestError = error
    } finally {
      client.close()
    }

    expect(requestError).toBe(bodyError)
  })

  it("preserves caller abort as the first causal error", async () => {
    const caller = new AbortController()
    const source = new PassThrough()
    const client = new SnapReq({baseUrl, transport: "node"})
    const request = client.post("/upload", source, {
      idleTimeoutMs: 1000,
      signal: caller.signal,
      timeoutMs: 0
    })

    caller.abort()

    try {
      await expect(() => request).toThrow(SnapReqAbortError)
    } finally {
      source.destroy()
      client.close()
    }
  })
})
