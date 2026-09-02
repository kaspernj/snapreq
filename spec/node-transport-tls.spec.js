// @ts-check

import {describe, expect, it} from "@velocious/testing"
import NodeTransport from "../src/transports/node-transport.js"

describe("NodeTransport TLS wiring", () => {
  it("forwards ca/cert/key and rejectUnauthorized=false to the https agent", async () => {
    const transport = new NodeTransport({tls: {ca: "ca-cert", cert: "client-cert", key: "client-key", rejectUnauthorized: false}})

    await transport._load()
    const agent = transport._agent(true)

    try {
      expect(agent.options.ca).toBe("ca-cert")
      expect(agent.options.cert).toBe("client-cert")
      expect(agent.options.key).toBe("client-key")
      expect(agent.options.rejectUnauthorized).toBe(false)
      expect(agent.keepAlive).toBe(true)
    } finally {
      transport.close()
    }
  })

  it("forwards rejectUnauthorized=true when explicitly requested", async () => {
    const transport = new NodeTransport({tls: {ca: "ca-cert", rejectUnauthorized: true}})

    await transport._load()
    const agent = transport._agent(true)

    try {
      expect(agent.options.rejectUnauthorized).toBe(true)
    } finally {
      transport.close()
    }
  })

  it("omits rejectUnauthorized from the agent when not provided", async () => {
    const transport = new NodeTransport({tls: {ca: "ca-cert"}})

    await transport._load()
    const agent = transport._agent(true)

    try {
      expect(agent.options.rejectUnauthorized).toBe(undefined)
    } finally {
      transport.close()
    }
  })
})
