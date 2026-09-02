// @ts-check

import {describe, expect, it} from "@velocious/testing"
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
  it("memoizes constructor-controlled ready access", async () => {
    const {channel} = buildChannel()
    const first = channel.ready
    const second = channel.ready

    expect(second).toBe(first)
    channel._handleSubscribed()
    await first
  })

  it("resolves ready when the client unsubscribes before the server acknowledges", async () => {
    const {channel, sent} = buildChannel()
    const ready = channel.ready

    channel.close()

    // Must resolve, not reject with "closed before acknowledgement" — a benign
    // unmount race where the caller closed the subscription itself.
    await ready
    expect(channel.isClosed()).toBeTrue()
    expect(sent).toEqual([{subscriptionId: "sub-1", type: "channel-unsubscribe"}])
  })

  it("rejects ready when the subscription closes before acknowledgement for any other reason", async () => {
    const {channel} = buildChannel()
    const ready = channel.ready

    channel._handleClosed("server_shutdown")

    await expect(async () => await ready).toThrow(/Subscription closed before acknowledgement: server_shutdown/)
  })

  it("resolves ready when the subscription is acknowledged", async () => {
    const {channel} = buildChannel()
    const ready = channel.ready

    channel._handleSubscribed()

    await ready
    expect(channel.isClosed()).toBeFalse()
  })
})
