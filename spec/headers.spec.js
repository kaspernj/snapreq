// @ts-check

import {describe, expect, it} from "@velocious/testing"
import SnapReqHeaders from "../src/headers.js"

describe("SnapReqHeaders", () => {
  it("looks up headers case-insensitively while preserving original casing", () => {
    const headers = new SnapReqHeaders({"Content-Type": "application/json"})

    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("CONTENT-TYPE")).toBe("application/json")
    expect(headers.toObject()).toEqual({"Content-Type": "application/json"})
  })

  it("overwrites a header regardless of the casing used", () => {
    const headers = new SnapReqHeaders({"Content-Type": "text/plain"})

    headers.set("content-type", "application/json")

    expect(headers.get("Content-Type")).toBe("application/json")
    expect(headers.toArray()).toHaveLength(1)
  })

  it("copies from another SnapReqHeaders instance", () => {
    const source = new SnapReqHeaders({Authorization: "Bearer x"})
    const copy = new SnapReqHeaders(source)

    expect(copy.get("authorization")).toBe("Bearer x")
  })

  it("copies from structurally compatible header iterables", () => {
    const source = new SnapReqHeaders({"X-Source": "yes"})
    const copy = new SnapReqHeaders([...source])

    expect([...source]).toEqual([["X-Source", "yes"]])
    expect(copy.get("x-source")).toBe("yes")
  })

  it("joins array values and skips null/undefined", () => {
    const headers = new SnapReqHeaders({Accept: ["application/json", "text/plain"], "X-None": /** @type {any} */ (null)})

    expect(headers.get("accept")).toBe("application/json, text/plain")
    expect(headers.has("x-none")).toBeFalse()
  })
})
