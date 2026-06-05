// @ts-check

import {describe, it} from "node:test"
import assert from "node:assert/strict"
import SnapReqWebSocketChannel from "../src/websocket/websocket-channel.js"

function buildChannel() {
  /** @type {any[]} */
  const sent = []
  /** @type {string[]} */
  const removed = []
  const client = /** @type {any} */ ({
    isOpen: () => true,
    _removeChannelSubscription: (/** @type {string} */ id) => removed.push(id),
    _sendMessage: (/** @type {any} */ message) => sent.push(message)
  })
  const channel = new SnapReqWebSocketChannel({channelType: "TestChannel", client, subscriptionId: "sub-1"})

  return {channel, removed, sent}
}

describe("SnapReqWebSocketChannel ready lifecycle", () => {
  it("resolves ready when the client unsubscribes before the server acknowledges", async () => {
    const {channel, sent} = buildChannel()
    const ready = channel.ready

    channel.close()

    // Must resolve, not reject with "closed before acknowledgement" — a benign
    // unmount race where the caller closed the subscription itself.
    await ready
    assert.equal(channel.isClosed(), true)
    assert.deepEqual(sent, [{subscriptionId: "sub-1", type: "channel-unsubscribe"}])
  })

  it("rejects ready when the subscription closes before acknowledgement for any other reason", async () => {
    const {channel} = buildChannel()
    const ready = channel.ready

    channel._handleClosed("server_shutdown")

    await assert.rejects(ready, /Subscription closed before acknowledgement: server_shutdown/)
  })

  it("resolves ready when the subscription is acknowledged", async () => {
    const {channel} = buildChannel()
    const ready = channel.ready

    channel._handleSubscribed()

    await ready
    assert.equal(channel.isClosed(), false)
  })
})
