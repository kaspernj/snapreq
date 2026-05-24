// @ts-check

import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import SnapReqWebSocketClient from "../src/websocket/websocket-client.js"
import {startTestWebSocketServer} from "./support/test-websocket-server.js"

/** @type {Awaited<ReturnType<typeof startTestWebSocketServer>>} */
let server

before(async () => {
  server = await startTestWebSocketServer()
})

after(async () => {
  await server.close()
})

describe("SnapReqWebSocketClient", () => {
  it("requires a url", () => {
    assert.throws(() => new SnapReqWebSocketClient(/** @type {any} */ ({})), /requires a url/)
  })

  it("connects and becomes session-ready", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()

    assert.equal(client.isOpen(), true)
    assert.equal(client.isSessionReady(), true)

    await client.close()
  })

  it("round-trips a request/response over the socket", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    const response = await client.post("/things", {name: "thing"})

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {echoed: {method: "POST", path: "/things", body: {name: "thing"}}})

    await client.close()
  })

  it("applies the deserialize hook in response.json()", async () => {
    const client = new SnapReqWebSocketClient({
      url: server.url,
      autoReconnect: false,
      deserialize: (value) => ({...value, deserialized: true})
    })
    const response = await client.post("/things", {name: "thing"})

    assert.equal(response.json().deserialized, true)

    await client.close()
  })

  it("subscribes to a channel and receives events", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    /** @type {any[]} */
    const received = []
    const unsubscribe = await client.subscribeAndWait("updates", {}, (payload) => received.push(payload))

    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(received, [{hello: "world"}])

    unsubscribe()
    await client.close()
  })

  it("opens a 1:1 connection and delivers its messages", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()

    /** @type {any[]} */
    const messages = []
    const connection = client.openConnection("ChatConnection", {onMessage: (body) => messages.push(body)})

    await connection.ready
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(connection.isConnected(), true)
    assert.deepEqual(messages, [{welcome: true}])

    connection.close()
    await client.close()
  })

  it("subscribes to a server channel handle and receives messages", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()

    /** @type {any[]} */
    const messages = []
    const subscription = client.subscribeChannel("TickChannel", {onMessage: (body) => messages.push(body)})

    await subscription.waitForReady({timeoutMs: 1000})
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(messages, [{tick: 1}])

    subscription.close()
    await client.close()
  })
})
