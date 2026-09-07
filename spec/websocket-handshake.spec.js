// @ts-check

import {describe, expect, it} from "@velocious/testing"
import SnapReqWebSocketClient from "../src/websocket/websocket-client.js"

/** A peer controlled by protocol milestones, without clocks or reconnect retries. */
function handshakeTransport() {
  let nextSocket = Promise.withResolvers()

  class HandshakeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    CONNECTING = 0
    OPEN = 1
    CLOSING = 2
    CLOSED = 3
    readyState = this.CONNECTING
    sent = []
    subscriptions = new Map()
    resumeRequested = Promise.withResolvers()

    constructor() {
      super()
      const created = nextSocket
      nextSocket = Promise.withResolvers()
      created.resolve(this)
    }

    open() {
      this.readyState = this.OPEN
      this.dispatchEvent(new Event("open"))
    }

    establish(sessionId) {
      this.open()
      // An upgrade and its first frame may be delivered in one transport turn.
      this.receive({type: "session-established", sessionId})
    }

    receive(message) {
      this.dispatchEvent(new MessageEvent("message", {data: JSON.stringify(message)}))
    }

    send(data) {
      const message = JSON.parse(data)
      this.sent.push(message)

      if (message.type === "session-resume") {
        this.resumeRequested.resolve(message)
      } else if (message.type === "channel-subscribe") {
        const duplicate = this.subscriptions.has(message.subscriptionId)
        if (!duplicate) this.subscriptions.set(message.subscriptionId, message.params)

        queueMicrotask(() => this.receive(duplicate
          ? {type: "channel-error", subscriptionId: message.subscriptionId, message: "Subscription id already in use"}
          : {type: "channel-subscribed", subscriptionId: message.subscriptionId}))
      }
    }

    publish(tenant, value) {
      for (const [subscriptionId, params] of this.subscriptions) {
        if (params.tenant === tenant) this.receive({type: "channel-message", subscriptionId, body: value})
      }
    }

    close() {
      this.readyState = this.CLOSED
      this.dispatchEvent(new Event("close"))
    }
  }

  return {nextSocket: () => nextSocket.promise, WebSocket: HandshakeWebSocket}
}

describe("WebSocket handshake ordering", () => {
  it("never resumes a fresh coalesced session or duplicates its subscription", async () => {
    const transport = handshakeTransport()
    const client = new SnapReqWebSocketClient({url: "ws://handshake.test", webSocketImplementation: transport.WebSocket})
    const socketCreated = transport.nextSocket()
    const connected = client.connect()
    const socket = await socketCreated

    try {
      socket.establish("fresh-session")
      await connected
      const received = []
      const channel = client.subscribeChannel("Events", {params: {tenant: "first"}, onMessage: (body) => received.push(body)})
      await channel.ready

      expect(socket.sent.filter((message) => message.type === "session-resume")).toEqual([])
      expect(socket.sent.filter((message) => message.type === "channel-subscribe").length).toBe(1)
      socket.publish("first", "first-event")
      expect(received).toEqual(["first-event"])
      expect(channel.isSubscribed()).toBe(true)
    } finally {
      await client.close()
    }
  })

  for (const outcome of ["session-resumed", "session-gone"]) {
    it(`fences coalesced reconnect readiness through ${outcome} and delivers each tenant exactly once`, async () => {
      const transport = handshakeTransport()
      const client = new SnapReqWebSocketClient({url: "ws://handshake.test", webSocketImplementation: transport.WebSocket})
      const firstCreated = transport.nextSocket()
      const firstConnect = client.connect()
      const firstSocket = await firstCreated

      try {
        firstSocket.open()
        // Separate establishment from open to isolate the reconnect regression.
        await Promise.resolve()
        firstSocket.receive({type: "session-established", sessionId: "original-session"})
        await firstConnect
        const firstEvents = []
        const secondEvents = []
        const first = client.subscribeChannel("Events", {params: {tenant: "first"}, onMessage: (body) => firstEvents.push(body)})
        await first.ready
        await client.dropConnection()

        const nextCreated = transport.nextSocket()
        const reconnect = client.connect()
        const concurrentReconnect = client.connect()
        let reconnectReady = false
        let concurrentReady = false
        const reconnected = reconnect.then(() => { reconnectReady = true })
        const concurrent = concurrentReconnect.then(() => { concurrentReady = true })
        const socket = await nextCreated
        socket.establish("replacement-session")
        const resume = await socket.resumeRequested.promise
        // Drain promise continuations while the peer withholds the resume reply.
        await new Promise((resolve) => setImmediate(resolve))

        expect(resume.sessionId).toBe("original-session")
        expect(client.isSessionReady()).toBe(false)
        expect(reconnectReady).toBe(false)
        expect(concurrentReady).toBe(false)

        const second = client.subscribeChannel("Events", {params: {tenant: "second"}, onMessage: (body) => secondEvents.push(body)})
        const secondReady = second.ready
        expect(socket.sent.filter((message) => message.type === "channel-subscribe")).toEqual([])
        if (outcome === "session-resumed") socket.subscriptions = new Map(firstSocket.subscriptions)
        socket.receive({type: outcome, sessionId: "original-session"})
        await reconnected
        await concurrent
        await first.waitForReady()
        await secondReady

        const subscriptions = socket.sent.filter((message) => message.type === "channel-subscribe")
        expect(subscriptions.filter((message) => message.subscriptionId === first.subscriptionId).length).toBe(outcome === "session-gone" ? 1 : 0)
        expect(subscriptions.filter((message) => message.subscriptionId === second.subscriptionId).length).toBe(1)
        expect(client.state().listenerCount).toBe(2)
        socket.publish("first", "first-event")
        expect(firstEvents).toEqual(["first-event"])
        expect(secondEvents).toEqual([])
        socket.publish("second", "second-event")
        expect(firstEvents).toEqual(["first-event"])
        expect(secondEvents).toEqual(["second-event"])
      } finally {
        await client.close()
      }
    })
  }

  it("rejects every reconnect waiter when the socket closes before resume without poisoning the next generation", async () => {
    const transport = handshakeTransport()
    const client = new SnapReqWebSocketClient({url: "ws://handshake.test", webSocketImplementation: transport.WebSocket})
    const firstCreated = transport.nextSocket()
    const firstConnect = client.connect()
    const firstSocket = await firstCreated

    try {
      firstSocket.establish("original-session")
      await firstConnect
      await client.dropConnection()

      const reconnectCreated = transport.nextSocket()
      const reconnect = client.connect({autoReconnect: false})
      const concurrentReconnect = client.connect({autoReconnect: false})
      const reconnectResults = Promise.allSettled([reconnect, concurrentReconnect])
      const socket = await reconnectCreated
      socket.establish("replacement-session")
      const resume = await socket.resumeRequested.promise

      expect(resume.sessionId).toBe("original-session")
      expect(client.isOpen()).toBe(true)
      expect(client.isSessionReady()).toBe(false)
      socket.close()

      const results = await reconnectResults
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
      expect(results[0].reason).toBeInstanceOf(Error)
      expect(results[0].reason.message).toBe("Websocket session readiness was reset")
      expect(results[1].reason).toBe(results[0].reason)
      expect(client.isOpen()).toBe(false)
      expect(client.isSessionReady()).toBe(false)

      const nextCreated = transport.nextSocket()
      const nextConnect = client.connect()
      const nextConcurrentConnect = client.connect()
      const nextSocket = await nextCreated
      nextSocket.establish("next-session")
      await Promise.all([nextConnect, nextConcurrentConnect])

      expect(client.isOpen()).toBe(true)
      expect(client.isSessionReady()).toBe(true)
      expect(nextSocket.sent.filter((message) => message.type === "session-resume")).toEqual([])
    } finally {
      await client.close()
    }
  })

  for (const storedId of ["stored-session", null]) {
    it(`waits for cold session storage before accepting coalesced establishment (${storedId ?? "empty"})`, async () => {
      const transport = handshakeTransport()
      const storage = Promise.withResolvers()
      let storageReads = 0
      const client = new SnapReqWebSocketClient({
        url: "ws://handshake.test",
        webSocketImplementation: transport.WebSocket,
        sessionStore: {
          get: () => { storageReads += 1; return storage.promise },
          set: () => {},
          clear: () => {}
        }
      })
      const created = transport.nextSocket()
      const connecting = client.connect()
      const socket = await created

      try {
        socket.establish("fresh-session")
        await new Promise((resolve) => setImmediate(resolve))
        expect(storageReads).toBe(1)
        expect(client.isSessionReady()).toBe(false)
        storage.resolve(storedId)

        if (storedId) {
          const resume = await socket.resumeRequested.promise
          expect(resume.sessionId).toBe(storedId)
          expect(client.isSessionReady()).toBe(false)
          socket.receive({type: "session-resumed", sessionId: storedId})
        }

        await connecting
        expect(client.isSessionReady()).toBe(true)
        expect(socket.sent.filter((message) => message.type === "session-resume").length).toBe(storedId ? 1 : 0)
      } finally {
        storage.resolve(null)
        await client.close()
      }
    })
  }
})
