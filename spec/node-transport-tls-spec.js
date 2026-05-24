// @ts-check

import {describe, it} from "node:test"
import assert from "node:assert/strict"
import NodeTransport from "../src/transports/node-transport.js"

describe("NodeTransport TLS wiring", () => {
  it("forwards ca/cert/key and rejectUnauthorized=false to the https agent", async () => {
    const transport = new NodeTransport({tls: {ca: "ca-cert", cert: "client-cert", key: "client-key", rejectUnauthorized: false}})

    await transport._load()
    const agent = transport._agent(true)

    try {
      assert.equal(agent.options.ca, "ca-cert")
      assert.equal(agent.options.cert, "client-cert")
      assert.equal(agent.options.key, "client-key")
      assert.equal(agent.options.rejectUnauthorized, false)
      assert.equal(agent.keepAlive, true)
    } finally {
      transport.close()
    }
  })

  it("forwards rejectUnauthorized=true when explicitly requested", async () => {
    const transport = new NodeTransport({tls: {ca: "ca-cert", rejectUnauthorized: true}})

    await transport._load()
    const agent = transport._agent(true)

    try {
      assert.equal(agent.options.rejectUnauthorized, true)
    } finally {
      transport.close()
    }
  })

  it("omits rejectUnauthorized from the agent when not provided", async () => {
    const transport = new NodeTransport({tls: {ca: "ca-cert"}})

    await transport._load()
    const agent = transport._agent(true)

    try {
      assert.equal(agent.options.rejectUnauthorized, undefined)
    } finally {
      transport.close()
    }
  })
})
