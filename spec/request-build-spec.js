// @ts-check

import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {Readable} from "node:stream"
import {buildUrl, isStreamBody, normalizeBody} from "../src/request.js"
import SnapReqHeaders from "../src/headers.js"

describe("buildUrl", () => {
  it("joins a base URL and a relative path", () => {
    assert.equal(buildUrl("http://host:2375", "/version"), "http://host:2375/version")
    assert.equal(buildUrl("http://host:2375/", "version"), "http://host:2375/version")
  })

  it("uses an absolute path verbatim, ignoring the base", () => {
    assert.equal(buildUrl("http://host", "https://other/api"), "https://other/api")
  })

  it("appends query parameters and skips null/undefined", () => {
    const url = buildUrl("http://host", "/list", {all: true, since: undefined, name: null, limit: 5})

    assert.equal(url, "http://host/list?all=true&limit=5")
  })

  it("merges query parameters onto an existing query string", () => {
    assert.equal(buildUrl("http://host", "/list?a=1", {b: 2}), "http://host/list?a=1&b=2")
  })
})

describe("normalizeBody", () => {
  it("treats a plain object as JSON and defaults the content type", () => {
    const headers = new SnapReqHeaders()
    const body = normalizeBody({a: 1}, headers)

    assert.equal(body.kind, "text")
    assert.equal(body.value, "{\"a\":1}")
    assert.equal(headers.get("content-type"), "application/json")
  })

  it("keeps a string body as-is without forcing a content type", () => {
    const headers = new SnapReqHeaders()
    const body = normalizeBody("raw", headers)

    assert.equal(body.kind, "text")
    assert.equal(body.value, "raw")
    assert.equal(headers.has("content-type"), false)
  })

  it("treats Uint8Array as bytes and defaults to octet-stream", () => {
    const headers = new SnapReqHeaders()
    const body = normalizeBody(new Uint8Array([1, 2, 3]), headers)

    assert.equal(body.kind, "bytes")
    assert.equal(headers.get("content-type"), "application/octet-stream")
  })

  it("treats a Readable as a stream body", () => {
    const headers = new SnapReqHeaders()
    const body = normalizeBody(Readable.from(["a", "b"]), headers)

    assert.equal(body.kind, "stream")
  })

  it("returns none for null/undefined", () => {
    assert.equal(normalizeBody(undefined, new SnapReqHeaders()).kind, "none")
    assert.equal(normalizeBody(null, new SnapReqHeaders()).kind, "none")
  })
})

describe("isStreamBody", () => {
  it("recognizes async iterables and node streams but not byte buffers", () => {
    assert.equal(isStreamBody(Readable.from(["a"])), true)
    assert.equal(isStreamBody(new Uint8Array([1])), false)
    assert.equal(isStreamBody(new ArrayBuffer(4)), false)
    assert.equal(isStreamBody({a: 1}), false)
    assert.equal(isStreamBody("text"), false)
  })
})
