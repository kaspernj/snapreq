// @ts-check

import {afterAll, beforeAll, describe, expect, it} from "@velocious/testing"
import http from "node:http"
import {SnapReqHttpError, SnapReqUnsupportedFeatureError} from "../src/errors.js"
import SnapReqHeaders from "../src/headers.js"
import SnapReqResponse from "../src/response.js"
import SnapReq from "../src/snap-req.js"
import FetchTransport from "../src/transports/fetch-transport.js"
import ProxyBounceTransport from "../src/transports/proxy-bounce-transport.js"
import XhrTransport from "../src/transports/xhr-transport.js"

/**
 * Starts the redirect/response-bound fixtures.
 * @returns {Promise<{close: () => Promise<void>, sourceUrl: string, targetHeaders: () => import("node:http").IncomingHttpHeaders}>}
 */
async function startServers() {
  /** @type {import("node:http").IncomingHttpHeaders} */
  let observedTargetHeaders = {}
  const target = http.createServer((request, response) => {
    observedTargetHeaders = request.headers
    response.writeHead(200, {"Content-Type": "text/plain", "X-Target": "yes"})
    response.end("redirected")
  })

  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve))
  const targetAddress = target.address()

  if (!targetAddress || typeof targetAddress === "string") throw new Error("Failed to bind redirect target")

  const source = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost")

    if (url.pathname === "/redirect") {
      response.writeHead(302, {Location: `http://127.0.0.1:${targetAddress.port}/target`})
      response.end("redirect body")
    } else if (url.pathname === "/same-origin-redirect") {
      response.writeHead(302, {Location: "/small"})
      response.end("same-origin redirect body")
    } else if (url.pathname === "/small") {
      response.writeHead(200, {"Content-Type": "text/plain"})
      response.end("small")
    } else if (url.pathname === "/loop") {
      response.writeHead(302, {Location: "/loop"})
      response.end()
    } else if (url.pathname === "/redirect-to-error") {
      response.writeHead(303, {Location: "/redirect-error"})
      response.end()
    } else if (url.pathname === "/redirect-error") {
      response.writeHead(503, {"Content-Type": "text/plain"})
      response.end("unavailable")
    } else if (url.pathname === "/declared-large") {
      response.writeHead(200, {"Content-Length": "9", "Content-Type": "text/plain"})
      response.end("123456789")
    } else if (url.pathname === "/chunked-large") {
      response.writeHead(200, {"Content-Type": "text/plain"})
      response.write("1234")
      response.end("56789")
    } else {
      response.writeHead(404)
      response.end()
    }
  })

  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve))
  const sourceAddress = source.address()

  if (!sourceAddress || typeof sourceAddress === "string") throw new Error("Failed to bind redirect source")

  return {
    close: async () => {
      await Promise.all([
        new Promise((resolve) => source.close(resolve)),
        new Promise((resolve) => target.close(resolve))
      ])
    },
    sourceUrl: `http://127.0.0.1:${sourceAddress.port}`,
    targetHeaders: () => observedTargetHeaders
  }
}

describe("SnapReq redirects and response bounds", () => {
  /** @type {Awaited<ReturnType<typeof startServers>>} */
  let servers

  beforeAll(async () => {
    servers = await startServers()
  })

  afterAll(async () => {
    await servers.close()
  })

  it("returns redirects unchanged when no explicit policy is configured", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, transport: "node"})

    try {
      const response = await client.get("/redirect")

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toMatch(/^http:\/\/127\.0\.0\.1:/)
    } finally {
      client.close()
    }
  })

  it("returns redirects without following them in manual mode", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, redirect: "manual", transport: "node"})

    try {
      const response = await client.get("/redirect")

      expect(response.status).toBe(302)
      expect(await response.text()).toBe("redirect body")
    } finally {
      client.close()
    }
  })

  for (const redirect of ["manual", "follow"]) {
    it(`rejects ${redirect} when browser Fetch hides the redirect response`, async () => {
      const originalFetch = globalThis.fetch

      globalThis.fetch = async () => /** @type {Response} */ (/** @type {unknown} */ ({
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
        headers: {forEach: () => {}},
        status: 0,
        statusText: "",
        type: "opaqueredirect"
      }))

      const client = new SnapReq({redirect: /** @type {"manual" | "follow"} */ (redirect), transport: new FetchTransport()})

      try {
        await expect(() => client.get("https://example.test/redirect")).toThrow(SnapReqUnsupportedFeatureError)
      } finally {
        client.close()
        globalThis.fetch = originalFetch
      }
    })
  }

  for (const transport of ["node", "fetch"]) {
    it(`implements explicit same-origin redirects over ${transport}`, async () => {
      const client = new SnapReq({baseUrl: servers.sourceUrl, redirect: "follow", transport: /** @type {"node" | "fetch"} */ (transport)})

      try {
        const response = await client.get("/same-origin-redirect")

        expect(response.status).toBe(200)
        expect(response.url).toMatch(/\/small$/)
        expect(await response.text()).toBe("small")
      } finally {
        client.close()
      }
    })
  }

  it("rejects redirects in error mode without contacting the target", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, redirect: "error", transport: "node"})
    /** @type {Error | undefined} */
    let redirectError

    try {
      await client.get("/redirect", {headers: {Authorization: "Bearer secret"}})
    } catch (error) {
      if (error instanceof Error) redirectError = error
    } finally {
      client.close()
    }

    expect(redirectError?.name).toBe("SnapReqRedirectError")
    expect(redirectError?.message).toMatch(/redirect/i)
    expect(servers.targetHeaders().authorization).toBe(undefined)
  })

  it("follows redirects and strips credentials across origins while preserving Range", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, redirect: "follow", transport: "node"})

    try {
      const response = await client.get("/redirect", {
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=secret",
          "Proxy-Authorization": "Basic secret",
          Range: "bytes=5-"
        }
      })

      expect(response.status).toBe(200)
      expect(response.url).toMatch(/\/target$/)
      expect(response.headers.get("x-target")).toBe("yes")
      expect(await response.text()).toBe("redirected")
      expect(servers.targetHeaders().authorization).toBe(undefined)
      expect(servers.targetHeaders().cookie).toBe(undefined)
      expect(servers.targetHeaders()["proxy-authorization"]).toBe(undefined)
      expect(servers.targetHeaders().range).toBe("bytes=5-")
    } finally {
      client.close()
    }
  })

  it("stops a redirect loop at the configured maximum", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, maxRedirects: 2, redirect: "follow", transport: "node"})
    /** @type {Error | undefined} */
    let redirectError

    try {
      await client.get("/loop")
    } catch (error) {
      if (error instanceof Error) redirectError = error
    } finally {
      client.close()
    }

    expect(redirectError?.name).toBe("SnapReqRedirectError")
    expect(redirectError?.message).toMatch(/maximum of 2/i)
  })

  it("reports the final method and URL when a followed redirect fails", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, redirect: "follow", throwOnError: true, transport: "node"})
    /** @type {SnapReqHttpError | undefined} */
    let responseError

    try {
      await client.post("/redirect-to-error", "request body")
    } catch (error) {
      if (error instanceof SnapReqHttpError) responseError = error
    } finally {
      client.close()
    }

    expect(responseError).toBeInstanceOf(SnapReqHttpError)
    expect(responseError?.method).toBe("GET")
    expect(responseError?.url).toBe(`${servers.sourceUrl}/redirect-error`)
    expect(responseError?.message).toBe(`HTTP 503 GET ${servers.sourceUrl}/redirect-error: unavailable`)
  })

  it("reports header progress for every redirect hop", async () => {
    const client = new SnapReq()
    const request = client._normalize({method: "GET", path: "https://example.test/first", redirect: "follow"})
    const progress = []
    const responses = [
      new SnapReqResponse({
        bytes: new Uint8Array(0),
        headers: new SnapReqHeaders({Location: "/second"}),
        method: "GET",
        status: 302,
        url: "https://example.test/first"
      }),
      new SnapReqResponse({
        bytes: new Uint8Array(0),
        headers: new SnapReqHeaders({Location: "/final"}),
        method: "GET",
        status: 307,
        url: "https://example.test/second"
      }),
      new SnapReqResponse({
        bytes: new Uint8Array(0),
        method: "GET",
        status: 200,
        url: "https://example.test/final"
      })
    ]

    request.onProgress = (phase) => progress.push(phase)

    const response = await client._performWithRedirects(request, async () => /** @type {SnapReqResponse} */ (responses.shift()))

    expect(response.url).toBe("https://example.test/final")
    expect(progress).toEqual(["connect_or_headers", "connect_or_headers", "connect_or_headers"])
  })

  for (const path of ["/declared-large", "/chunked-large"]) {
    it(`rejects ${path.slice(1)} buffered responses above maxResponseBytes`, async () => {
      const client = new SnapReq({baseUrl: servers.sourceUrl, maxResponseBytes: 8, transport: "node"})
      const response = await client.get(path)
      /** @type {Error | undefined} */
      let responseError

      try {
        await response.bytes()
      } catch (error) {
        if (error instanceof Error) responseError = error
      } finally {
        client.close()
      }

      expect(responseError?.name).toBe("SnapReqResponseTooLargeError")
      expect(responseError?.message).toMatch(/8 bytes/)
    })
  }

  it("rejects bounded Fetch responses before fallback buffering", async () => {
    const originalFetch = globalThis.fetch
    let arrayBufferCalls = 0

    globalThis.fetch = async () => /** @type {Response} */ (/** @type {unknown} */ ({
      arrayBuffer: async () => {
        arrayBufferCalls += 1
        return new ArrayBuffer(16)
      },
      body: null,
      headers: {forEach: () => {}},
      status: 200,
      statusText: "OK",
      type: "basic"
    }))

    const client = new SnapReq({maxResponseBytes: 8, transport: new FetchTransport()})

    try {
      await expect(() => client.get("https://example.test/buffered")).toThrow(SnapReqUnsupportedFeatureError)
      expect(arrayBufferCalls).toBe(0)
    } finally {
      client.close()
      globalThis.fetch = originalFetch
    }
  })

  it("rejects bounded XHR responses before allocating an XMLHttpRequest", async () => {
    const originalXmlHttpRequest = globalThis.XMLHttpRequest
    let constructorCalls = 0

    globalThis.XMLHttpRequest = /** @type {typeof XMLHttpRequest} */ (class {
      constructor() {
        constructorCalls += 1
      }
    })

    const client = new SnapReq({maxResponseBytes: 8, transport: new XhrTransport()})

    try {
      await expect(() => client.get("https://example.test/buffered")).toThrow(SnapReqUnsupportedFeatureError)
      expect(constructorCalls).toBe(0)
    } finally {
      client.close()
      globalThis.XMLHttpRequest = originalXmlHttpRequest
    }
  })

  it("rejects bounded proxy-bounce responses before contacting the proxy", async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0

    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error("The proxy must not be contacted")
    }

    const client = new SnapReq({
      maxResponseBytes: 8,
      transport: new ProxyBounceTransport({proxyUrl: "https://proxy.example.test/request"})
    })

    try {
      await expect(() => client.get("https://example.test/buffered")).toThrow(SnapReqUnsupportedFeatureError)
      expect(fetchCalls).toBe(0)
    } finally {
      client.close()
      globalThis.fetch = originalFetch
    }
  })

  it("allows a request-level response bound to override the client default", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, maxResponseBytes: 4, transport: "node"})

    try {
      const response = await client.get("/declared-large", {maxResponseBytes: 9})

      expect(await response.text()).toBe("123456789")
    } finally {
      client.close()
    }
  })

  it("applies response bounds before yielding streamed chunks", async () => {
    const client = new SnapReq({baseUrl: servers.sourceUrl, maxResponseBytes: 8, transport: "node"})
    const response = await client.requestStream({method: "GET", path: "/chunked-large"})
    let yielded = ""
    /** @type {Error | undefined} */
    let responseError

    try {
      for await (const chunk of response.stream()) yielded += new TextDecoder().decode(chunk)
    } catch (error) {
      if (error instanceof Error) responseError = error
    } finally {
      client.close()
    }

    expect(yielded.length).toBeLessThanOrEqual(8)
    expect(responseError?.name).toBe("SnapReqResponseTooLargeError")
  })

  it("rejects invalid redirect and response-bound options before transport work", () => {
    expect(() => new SnapReq({redirect: /** @type {"follow"} */ ("sometimes")})).toThrow(/redirect must/)
    expect(() => new SnapReq({maxRedirects: 0})).toThrow(/maxRedirects/)
    expect(() => new SnapReq({maxResponseBytes: -1})).toThrow(/maxResponseBytes/)
  })
})
