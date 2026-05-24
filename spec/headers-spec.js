// @ts-check

import {describe, it} from "node:test"
import assert from "node:assert/strict"
import SnapReqHeaders from "../src/headers.js"

describe("SnapReqHeaders", () => {
  it("looks up headers case-insensitively while preserving original casing", () => {
    const headers = new SnapReqHeaders({"Content-Type": "application/json"})

    assert.equal(headers.get("content-type"), "application/json")
    assert.equal(headers.get("CONTENT-TYPE"), "application/json")
    assert.deepEqual(headers.toObject(), {"Content-Type": "application/json"})
  })

  it("overwrites a header regardless of the casing used", () => {
    const headers = new SnapReqHeaders({"Content-Type": "text/plain"})

    headers.set("content-type", "application/json")

    assert.equal(headers.get("Content-Type"), "application/json")
    assert.equal(headers.toArray().length, 1)
  })

  it("copies from another SnapReqHeaders instance", () => {
    const source = new SnapReqHeaders({Authorization: "Bearer x"})
    const copy = new SnapReqHeaders(source)

    assert.equal(copy.get("authorization"), "Bearer x")
  })

  it("joins array values and skips null/undefined", () => {
    const headers = new SnapReqHeaders({Accept: ["application/json", "text/plain"], "X-None": /** @type {any} */ (null)})

    assert.equal(headers.get("accept"), "application/json, text/plain")
    assert.equal(headers.has("x-none"), false)
  })
})
