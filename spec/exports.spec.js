// @ts-check

import {describe, expect, it} from "@velocious/testing"

const publicExports = [
  "snapreq",
  "snapreq/capabilities",
  "snapreq/errors",
  "snapreq/headers",
  "snapreq/response",
  "snapreq/retry",
  "snapreq/transports/fetch",
  "snapreq/transports/proxy-bounce-transport",
  "snapreq/transports/select",
  "snapreq/transports/xhr",
  "snapreq/websocket"
]

describe("package exports", () => {
  for (const publicExport of publicExports) {
    it(`resolves ${publicExport}`, async () => {
      const module = await import(publicExport)

      expect(typeof module).toBe("object")
    })
  }
})
