// @ts-check

import {describe, expect, it} from "@velocious/testing"
import {EventEmitter} from "node:events"
import SnapReqWebSocketClient from "../src/websocket/websocket-client.js"

/**
 * A minimal stand-in for a Node `ws` socket: EventEmitter (for `.on("pong")`)
 * plus the `ping`/`terminate`/`_socket.unref` surface the keepalive uses.
 * @param {{pongsBack?: boolean}} [options]
 * @returns {any}
 */
function fakeWsSocket({pongsBack = false} = {}) {
  const socket = new EventEmitter()
  const state = {pingCount: 0, terminated: false, unreffed: false}

  Object.assign(socket, {
    OPEN: 1,
    readyState: 1,
    state,
    _socket: {unref: () => { state.unreffed = true }},
    ping: () => {
      state.pingCount++
      if (pongsBack) socket.emit("pong")
    },
    terminate: () => { state.terminated = true },
    close: () => { state.terminated = true }
  })

  return socket
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {any}
 */
function heartbeatClient(overrides = {}) {
  return new SnapReqWebSocketClient({
    url: "ws://127.0.0.1:1/websocket",
    // A dummy impl so the constructor doesn't need a real global WebSocket; the
    // tests drive the keepalive against a fake socket directly.
    webSocketImplementation: /** @type {any} */ (class {}),
    autoReconnect: false,
    heartbeatIntervalMs: 15,
    unref: true,
    ...overrides
  })
}

describe("SnapReqWebSocketClient heartbeat + unref", () => {
  it("unrefs the underlying socket when unref is enabled", () => {
    const client = heartbeatClient()
    const socket = fakeWsSocket({pongsBack: true})

    client.socket = socket
    client._startSocketKeepalive()
    client._stopSocketKeepalive()

    expect(socket.state.unreffed).toBeTrue()
  })

  it("terminates the socket when the peer never pongs", async () => {
    const client = heartbeatClient()
    const socket = fakeWsSocket({pongsBack: false})

    client.socket = socket
    client._startSocketKeepalive()
    await new Promise((resolve) => setTimeout(resolve, 90))
    client._stopSocketKeepalive()

    expect(socket.state.pingCount).toBeGreaterThanOrEqual(1)
    expect(socket.state.terminated).toBeTrue()
  })

  it("keeps the socket alive while the peer pongs", async () => {
    const client = heartbeatClient()
    const socket = fakeWsSocket({pongsBack: true})

    client.socket = socket
    client._startSocketKeepalive()
    await new Promise((resolve) => setTimeout(resolve, 90))
    client._stopSocketKeepalive()

    expect(socket.state.pingCount).toBeGreaterThanOrEqual(1)
    expect(socket.state.terminated).toBeFalse()
  })

  it("is a no-op when the implementation cannot ping (browser/undici)", async () => {
    const client = heartbeatClient()
    const socket = new EventEmitter() // no ping/terminate/_socket

    client.socket = /** @type {any} */ (socket)

    await expect(() => {
      client._startSocketKeepalive()
      client._stopSocketKeepalive()
    }).not.toThrow()
  })
})
