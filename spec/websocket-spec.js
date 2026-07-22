// @ts-check

import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import SnapReqWebSocketClient from "../src/websocket/websocket-client.js"
import {TimeoutError} from "awaitery/build/timeout.js"
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
  const delay = (/** @type {number} */ milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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

  it("times out session readiness and closes the newly-created socket", async () => {
    const client = new SnapReqWebSocketClient({
      url: `${server.url}?no-session=1`,
      autoReconnect: true,
      reconnectDelays: [1]
    })

    await assert.rejects(() => client.connect({timeoutMs: 20}), TimeoutError)
    assert.equal(client.connectPromise, undefined)
    assert.equal(client.socket, undefined)
    assert.equal(client.isSessionReady(), false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(client.connectionAttempts, 1)
    assert.equal(client.reconnectTimer, null)
  })

  it("does not clear a newer connect while a failed socket finishes closing", async () => {
    const sockets = []
    let releaseFirstClose
    const firstCloseStarted = new Promise((resolve) => { releaseFirstClose = resolve })

    class GatedCloseWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      constructor() {
        super()
        this.CONNECTING = GatedCloseWebSocket.CONNECTING
        this.OPEN = GatedCloseWebSocket.OPEN
        this.CLOSING = GatedCloseWebSocket.CLOSING
        this.CLOSED = GatedCloseWebSocket.CLOSED
        this.readyState = this.CONNECTING
        sockets.push(this)

        if (sockets.length === 1) {
          queueMicrotask(() => {
            const event = new Event("error")
            Object.defineProperty(event, "error", {value: new Error("first connect failed")})
            this.dispatchEvent(event)
          })
        } else {
          queueMicrotask(() => {
            this.readyState = this.OPEN
            this.dispatchEvent(new Event("open"))
          })
        }
      }

      close() {
        this.readyState = this.CLOSING
        if (sockets[0] === this) releaseFirstClose()
      }

      finishClose() {
        this.readyState = this.CLOSED
        this.dispatchEvent(new Event("close"))
      }

      send() {}
    }

    const client = new SnapReqWebSocketClient({
      url: "ws://gated-close.test",
      autoReconnect: false,
      webSocketImplementation: /** @type {any} */ (GatedCloseWebSocket)
    })
    const firstConnect = client.connect()

    await firstCloseStarted
    const secondConnect = client.connect()
    const secondConnectPromise = client.connectPromise

    assert.equal(sockets.length, 2)
    sockets[0].finishClose()
    await assert.rejects(firstConnect, /first connect failed/)
    assert.equal(client.socket, sockets[1])
    assert.equal(client.connectPromise, secondConnectPromise)
    assert.equal(client._connectWaiters, 1)

    sockets[1].dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({type: "session-established", sessionId: "second"})
    }))
    await secondConnect

    assert.equal(client.socket, sockets[1])
    assert.equal(client.connectPromise, secondConnectPromise)
    assert.equal(client.connectionAttempts, 2)
    assert.equal(client._connectWaiters, 0)
    sockets[1].finishClose()
  })

  it("rejects queued legacy readiness when initial error precedes close", async () => {
    const connectionError = new Error("initial websocket failure")
    let socket

    class ErrorThenCloseWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      constructor() {
        this.CONNECTING = ErrorThenCloseWebSocket.CONNECTING
        this.OPEN = ErrorThenCloseWebSocket.OPEN
        this.CLOSING = ErrorThenCloseWebSocket.CLOSING
        this.CLOSED = ErrorThenCloseWebSocket.CLOSED
        this.readyState = this.CONNECTING
        this.listeners = new Map()
        socket = this

        queueMicrotask(() => {
          const event = new Event("error")
          Object.defineProperty(event, "error", {value: connectionError})
          this.dispatchEvent(event)
          setTimeout(() => {
            this.readyState = this.CLOSED
            this.dispatchEvent(new Event("close"))
          }, 0)
        })
      }

      addEventListener(type, listener, options) {
        const listeners = this.listeners.get(type) || new Map()
        listeners.set(listener, Boolean(options?.once))
        this.listeners.set(type, listeners)
      }

      removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener)
      }

      dispatchEvent(event) {
        Object.defineProperty(event, "currentTarget", {configurable: true, value: this})
        for (const [listener, once] of [...(this.listeners.get(event.type) || [])]) {
          if (once) this.removeEventListener(event.type, listener)
          if (typeof listener === "function") listener.call(this, event)
          else listener.handleEvent(event)
        }
        return true
      }

      close() {
        this.readyState = this.CLOSING
      }
    }

    const client = new SnapReqWebSocketClient({
      url: "ws://initial-failure.test",
      autoReconnect: true,
      reconnectDelays: [1],
      webSocketImplementation: /** @type {any} */ (ErrorThenCloseWebSocket)
    })
    const subscription = client.subscribe("updates", {}, () => {})
    const harnessTimeout = new Error("readiness remained pending")

    await assert.rejects(
      Promise.race([
        subscription.ready,
        delay(50).then(() => Promise.reject(harnessTimeout))
      ]),
      (error) => error === connectionError
    )
    await delay(10)

    assert.equal(client.pendingSubscriptions.size, 0)
    assert.equal(client.listeners.size, 0)
    assert.equal(socket?.listeners.get("close")?.size, 0)
    assert.equal(client.reconnectTimer, null)
    assert.equal(client.connectionAttempts, 1)
  })

  it("keeps a shared connecting socket alive for a queued legacy subscription", async () => {
    const sessionId = `shared-${Date.now()}`
    const requestUrl = `${server.url}?manual-session=${sessionId}`
    let markSocketOpened
    const socketOpened = new Promise((resolve) => { markSocketOpened = resolve })
    class TrackingWebSocket extends WebSocket {
      constructor(url) {
        super(url)
        this.addEventListener("open", () => markSocketOpened(), {once: true})
      }
    }
    const client = new SnapReqWebSocketClient({
      url: requestUrl,
      autoReconnect: false,
      webSocketImplementation: TrackingWebSocket
    })
    const received = []
    const timedRequest = client.get("/things", {timeoutMs: 50})
    await socketOpened
    const subscription = client.subscribe("updates", {timeoutMs: 1000}, (payload) => received.push(payload))
    const subscriptionReady = subscription.ready
    void subscriptionReady.catch(() => {})

    let requestError
    try {
      await timedRequest
    } catch (error) {
      requestError = error
    }
    assert.ok(requestError instanceof TimeoutError)
    server.releaseSession(sessionId)
    await subscriptionReady
    await new Promise((resolve) => {
      if (received.length > 0) resolve(undefined)
      else {
        const original = [...client.listeners.values()][0]
        original.callbacks.add(() => resolve(undefined))
      }
    })

    assert.deepEqual(received, [{hello: "world"}])
    assert.equal(client.connectionAttempts, 1)
    assert.equal(client.isSessionReady(), true)
    subscription()
    await client.close()
  })

  it("removes only a timed-out pending request", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()
    await assert.rejects(() => client.get("/hang", {timeoutMs: 20}), TimeoutError)
    assert.equal(client.pendingRequests.size, 0)
    assert.equal(client.isOpen(), true)
    await client.close()
  })

  it("removes a caller-cancelled pending request", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    const controller = new AbortController()

    await client.connect()
    const request = client.get("/hang", {signal: controller.signal})

    controller.abort()
    await assert.rejects(request, (error) => error === controller.signal.reason)
    assert.equal(client.pendingRequests.size, 0)
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

  it("keeps shared legacy subscription readiness alive when one callback times out", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    /** @type {any[]} */
    const received = []
    const first = client.subscribe("delayed-updates", {timeoutMs: 10}, () => received.push("first"))
    const second = client.subscribe("delayed-updates", {timeoutMs: 200}, () => received.push("second"))

    await assert.rejects(first.ready, TimeoutError)
    await second.ready
    await delay(10)

    assert.deepEqual(received, ["second"])
    assert.equal([...client.listeners.values()].find((listener) => listener.channel === "delayed-updates")?.callbacks.size, 1)
    second()
    await client.close()
  })

  it("does not send a queued legacy subscribe after every callback cancels", async () => {
    const requestUrl = `${server.url}?delay-session=${Date.now()}`
    const client = new SnapReqWebSocketClient({url: requestUrl, autoReconnect: false})
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = client.subscribe("updates", {signal: firstController.signal}, () => {})
    const second = client.subscribe("updates", {signal: secondController.signal}, () => {})

    firstController.abort("first-cancelled")
    secondController.abort("second-cancelled")
    await assert.rejects(first.ready, (error) => error === "first-cancelled")
    await assert.rejects(second.ready, (error) => error === "second-cancelled")
    await delay(70)

    assert.equal(server.receivedMessages.some((message) => message.requestUrl === `/?delay-session=${requestUrl.split("=")[1]}` && message.type === "subscribe"), false)
    await client.close()
  })

  for (const control of ["timeout", "cancellation"]) {
    it(`closes only a channel whose waitForReady ${control} fails`, async () => {
      const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
      await client.connect()
      const survivor = client.subscribeChannel("TickChannel")
      await survivor.ready
      const failed = client.subscribeChannel("DelayedChannel")
      const controller = new AbortController()
      const reason = new Error("channel wait cancelled")
      const waiting = failed.waitForReady(control === "timeout" ? {timeoutMs: 10} : {signal: controller.signal})
      if (control === "cancellation") controller.abort(reason)

      await assert.rejects(waiting, control === "timeout" ? TimeoutError : (error) => error === reason)
      await delay(10)

      assert.equal(failed.isClosed(), true)
      assert.equal(client._channelSubscriptions.has(failed.subscriptionId), false)
      assert.equal(server.receivedMessages.some((message) => message.type === "channel-unsubscribe" && message.subscriptionId === failed.subscriptionId), true)
      assert.equal(survivor.isSubscribed(), true)
      assert.equal(client.isOpen(), true)
      survivor.close()
      await client.close()
    })
  }

  it("uses normal cleanup when constructor-controlled channel readiness times out", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    await client.connect()
    const survivor = client.subscribeChannel("TickChannel")
    await survivor.ready
    const failed = client.subscribeChannel("DelayedChannel", {timeoutMs: 10})

    await assert.rejects(failed.ready, TimeoutError)
    await delay(10)

    assert.equal(failed.isClosed(), true)
    assert.equal(client._channelSubscriptions.has(failed.subscriptionId), false)
    assert.equal(server.receivedMessages.some((message) => message.type === "channel-unsubscribe" && message.subscriptionId === failed.subscriptionId), true)
    assert.equal(survivor.isSubscribed(), true)
    assert.equal(client.isOpen(), true)
    survivor.close()
    await client.close()
  })

  for (const control of ["timeout", "cancellation"]) {
    it(`uses normal cleanup when connection readiness ${control} fails`, async () => {
      const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
      await client.connect()
      const survivor = client.openConnection("ChatConnection")
      await survivor.ready
      const controller = new AbortController()
      const reason = new Error("connection cancelled")
      const failed = client.openConnection("DelayedConnection", control === "timeout" ? {timeoutMs: 10} : {signal: controller.signal})
      if (control === "cancellation") controller.abort(reason)

      await assert.rejects(failed.ready, control === "timeout" ? TimeoutError : (error) => error === reason)
      await delay(10)

      assert.equal(failed.isClosed(), true)
      assert.equal(client._connections.has(failed.connectionId), false)
      assert.equal(server.receivedMessages.some((message) => message.type === "connection-close" && message.connectionId === failed.connectionId), true)
      assert.equal(survivor.isConnected(), true)
      assert.equal(client.isOpen(), true)
      survivor.close()
      await client.close()
    })
  }
})
