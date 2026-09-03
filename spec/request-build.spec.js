// @ts-check

import {describe, expect, it} from "@velocious/testing"
import {Readable} from "node:stream"
import {buildUrl, isStreamBody, normalizeBody} from "../src/request.js"
import SnapReqHeaders from "../src/headers.js"

describe("request helpers", () => {
  describe("buildUrl", () => {
    it("joins a base URL and a relative path", () => {
      expect(buildUrl("http://host:2375", "/version")).toBe("http://host:2375/version")
      expect(buildUrl("http://host:2375/", "version")).toBe("http://host:2375/version")
    })

    it("uses an absolute path verbatim, ignoring the base", () => {
      expect(buildUrl("http://host", "https://other/api")).toBe("https://other/api")
    })

    it("appends query parameters and skips null/undefined", () => {
      const url = buildUrl("http://host", "/list", {all: true, since: undefined, name: null, limit: 5})

      expect(url).toBe("http://host/list?all=true&limit=5")
    })

    it("merges query parameters onto an existing query string", () => {
      expect(buildUrl("http://host", "/list?a=1", {b: 2})).toBe("http://host/list?a=1&b=2")
    })
  })

  describe("normalizeBody", () => {
    it("treats a plain object as JSON and defaults the content type", () => {
      const headers = new SnapReqHeaders()
      const body = normalizeBody({a: 1}, headers)

      expect(body.kind).toBe("text")
      expect(body.value).toBe("{\"a\":1}")
      expect(headers.get("content-type")).toBe("application/json")
    })

    it("keeps a string body as-is without forcing a content type", () => {
      const headers = new SnapReqHeaders()
      const body = normalizeBody("raw", headers)

      expect(body.kind).toBe("text")
      expect(body.value).toBe("raw")
      expect(headers.has("content-type")).toBeFalse()
    })

    it("treats Uint8Array as bytes and defaults to octet-stream", () => {
      const headers = new SnapReqHeaders()
      const body = normalizeBody(new Uint8Array([1, 2, 3]), headers)

      expect(body.kind).toBe("bytes")
      expect(headers.get("content-type")).toBe("application/octet-stream")
    })

    it("treats a Readable as a stream body", () => {
      const headers = new SnapReqHeaders()
      const body = normalizeBody(Readable.from(["a", "b"]), headers)

      expect(body.kind).toBe("stream")
    })

    it("returns none for null/undefined", () => {
      expect(normalizeBody(undefined, new SnapReqHeaders()).kind).toBe("none")
      expect(normalizeBody(null, new SnapReqHeaders()).kind).toBe("none")
    })
  })

  describe("isStreamBody", () => {
    it("recognizes async iterables and node streams but not byte buffers", () => {
      expect(isStreamBody(Readable.from(["a"]))).toBeTrue()
      expect(isStreamBody(new Uint8Array([1]))).toBeFalse()
      expect(isStreamBody(new ArrayBuffer(4))).toBeFalse()
      expect(isStreamBody({a: 1})).toBeFalse()
      expect(isStreamBody("text")).toBeFalse()
    })
  })
})
