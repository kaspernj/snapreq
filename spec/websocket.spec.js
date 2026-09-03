// @ts-check

import {afterAll, beforeAll, describe, expect, it} from "@velocious/testing"
import SnapReqWebSocketClient from "../src/websocket/websocket-client.js"
import {TimeoutError} from "awaitery/build/timeout.js"
import {startTestWebSocketServer} from "./support/test-websocket-server.js"

describe("SnapReqWebSocketClient", () => {
  /** @type {Awaited<ReturnType<typeof startTestWebSocketServer>>} */
  let server

  beforeAll(async () => {
    server = await startTestWebSocketServer()
  })

  afterAll(async () => {
    await server.close()
  })

  const delay = (/** @type {number} */ milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

  it("requires a url", async () => {
    await expect(() => new SnapReqWebSocketClient(/** @type {any} */ ({}))).toThrow(/requires a url/)
  })

  it("connects and becomes session-ready", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()

    expect(client.isOpen()).toBe(true)
    expect(client.isSessionReady()).toBe(true)

    await client.close()
  })

  it("round-trips a request/response over the socket", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    const response = await client.post("/things", {name: "thing"})

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({echoed: {method: "POST", path: "/things", body: {name: "thing"}}})

    await client.close()
  })

  it("times out session readiness and closes the newly-created socket", async () => {
    const client = new SnapReqWebSocketClient({
      url: `${server.url}?no-session=1`,
      autoReconnect: true,
      reconnectDelays: [1]
    })

    await expect(() => client.connect({timeoutMs: 20})).toThrow(TimeoutError)
    expect(client.connectPromise).toBe(undefined)
    expect(client.socket).toBe(undefined)
    expect(client.isSessionReady()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.connectionAttempts).toBe(1)
    expect(client.reconnectTimer).toBe(null)
  })

  it("closes a shared in-flight socket after every connect waiter times out", async () => {
    let socket
    let resolveOpen
    const opened = new Promise((resolve) => { resolveOpen = resolve })

    class OpenWithoutSessionWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      constructor() {
        super()
        this.CONNECTING = OpenWithoutSessionWebSocket.CONNECTING
        this.OPEN = OpenWithoutSessionWebSocket.OPEN
        this.CLOSING = OpenWithoutSessionWebSocket.CLOSING
        this.CLOSED = OpenWithoutSessionWebSocket.CLOSED
        this.readyState = this.CONNECTING
        this.closeCalls = 0
        socket = this

        queueMicrotask(() => {
          this.readyState = this.OPEN
          this.dispatchEvent(new Event("open"))
          resolveOpen()
        })
      }

      close() {
        this.closeCalls += 1
        this.readyState = this.CLOSED
        this.dispatchEvent(new Event("close"))
      }

      send() {}
    }

    const client = new SnapReqWebSocketClient({
      url: "ws://shared-timeout.test",
      autoReconnect: true,
      reconnectDelays: [1],
      webSocketImplementation: /** @type {any} */ (OpenWithoutSessionWebSocket)
    })
    const firstConnect = client.connect({timeoutMs: 20})

    await opened
    const secondConnect = client.connect({timeoutMs: 30})

    await expect(() => firstConnect).toThrow(TimeoutError)
    await expect(() => secondConnect).toThrow(TimeoutError)
    expect(socket.closeCalls).toBe(1)
    expect(client.socket).toBe(undefined)
    expect(client.connectPromise).toBe(undefined)
    expect(client._connectWaiters).toBe(0)
    expect(client.reconnectTimer).toBe(null)
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

    expect(sockets.length).toBe(2)
    sockets[0].finishClose()
    await expect(() => firstConnect).toThrow(/first connect failed/)
    expect(client.socket).toBe(sockets[1])
    expect(client.connectPromise).toBe(secondConnectPromise)
    expect(client._connectWaiters).toBe(1)

    sockets[1].dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({type: "session-established", sessionId: "second"})
    }))
    await secondConnect

    expect(client.socket).toBe(sockets[1])
    expect(client.connectPromise).toBe(secondConnectPromise)
    expect(client.connectionAttempts).toBe(2)
    expect(client._connectWaiters).toBe(0)
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

    /** @type {unknown} */
    let readinessError

    try {
      await Promise.race([
        subscription.ready,
        delay(50).then(() => Promise.reject(harnessTimeout))
      ])
    } catch (error) {
      readinessError = error
    }

    expect(readinessError).toBe(connectionError)
    await delay(10)

    expect(client.pendingSubscriptions.size).toBe(0)
    expect(client.listeners.size).toBe(0)
    expect(socket?.listeners.get("close")?.size).toBe(0)
    expect(client.reconnectTimer).toBe(null)
    expect(client.connectionAttempts).toBe(1)
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

    /** @type {unknown} */
    let requestError
    try {
      await timedRequest
    } catch (error) {
      requestError = error
    }
    expect(requestError).toBeInstanceOf(TimeoutError)
    server.releaseSession(sessionId)
    await subscriptionReady
    await new Promise((resolve) => {
      if (received.length > 0) resolve(undefined)
      else {
        const original = [...client.listeners.values()][0]
        original.callbacks.add(() => resolve(undefined))
      }
    })

    expect(received).toEqual([{hello: "world"}])
    expect(client.connectionAttempts).toBe(1)
    expect(client.isSessionReady()).toBe(true)
    subscription()
    await client.close()
  })

  it("removes only a timed-out pending request", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()
    await expect(() => client.get("/hang", {timeoutMs: 20})).toThrow(TimeoutError)
    expect(client.pendingRequests.size).toBe(0)
    expect(client.isOpen()).toBe(true)
    await client.close()
  })

  it("removes a caller-cancelled pending request", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    const controller = new AbortController()

    await client.connect()
    const request = client.get("/hang", {signal: controller.signal})

    controller.abort()
    /** @type {unknown} */
    let requestError

    try {
      await request
    } catch (error) {
      requestError = error
    }

    expect(requestError).toBe(controller.signal.reason)
    expect(client.pendingRequests.size).toBe(0)
    await client.close()
  })

  it("applies the deserialize hook in response.json()", async () => {
    const client = new SnapReqWebSocketClient({
      url: server.url,
      autoReconnect: false,
      deserialize: (value) => ({...value, deserialized: true})
    })
    const response = await client.post("/things", {name: "thing"})

    expect(response.json().deserialized).toBe(true)

    await client.close()
  })

  it("subscribes to a channel and receives events", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    /** @type {any[]} */
    const received = []
    const unsubscribe = await client.subscribeAndWait("updates", {}, (payload) => received.push(payload))

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received).toEqual([{hello: "world"}])

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

    expect(connection.isConnected()).toBe(true)
    expect(messages).toEqual([{welcome: true}])

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

    expect(messages).toEqual([{tick: 1}])

    subscription.close()
    await client.close()
  })

  class ResumableWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    constructor() {
      super()
      this.CONNECTING = ResumableWebSocket.CONNECTING
      this.OPEN = ResumableWebSocket.OPEN
      this.CLOSING = ResumableWebSocket.CLOSING
      this.CLOSED = ResumableWebSocket.CLOSED
      this.readyState = this.CONNECTING
      this.failConnection = false

      queueMicrotask(() => {
        if (this.failConnection) {
          const event = new Event("error")

          Object.defineProperty(event, "error", {value: new Error("reconnect failed")})
          this.dispatchEvent(event)
          return
        }

        this.readyState = this.OPEN
        this.dispatchEvent(new Event("open"))
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({type: "session-established", sessionId: "resumable-session"})
        })), 0)
      })
    }

    /** @param {string} raw - Serialized client message. */
    send(raw) {
      const message = JSON.parse(raw)
      let response

      if (message.type === "connection-open") {
        response = {type: "connection-opened", connectionId: message.connectionId}
      } else if (message.type === "channel-subscribe") {
        response = {type: "channel-subscribed", subscriptionId: message.subscriptionId}
      }

      if (response) {
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify(response)
        })), 0)
      }
    }

    close() {
      if (this.readyState === this.CLOSED) return

      this.readyState = this.CLOSED
      this.dispatchEvent(new Event("close"))
    }
  }

  it("reports explicit client shutdown while handle acknowledgements are pending", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})

    await client.connect()

    const subscription = client.subscribeChannel("DelayedChannel")
    const connection = client.openConnection("DelayedConnection")
    const readiness = Promise.all([
      expect(async () => await subscription.ready).toThrow(/Subscription closed before acknowledgement: client_close/),
      expect(async () => await connection.ready).toThrow(/Connection closed before open: client_close/)
    ])

    await client.disconnectAndStopReconnect()
    await readiness
  })

  it("closes resumable handles when explicit shutdown follows a dropped socket", async () => {
    const client = new SnapReqWebSocketClient({
      url: "ws://resumable.test",
      autoReconnect: true,
      reconnectDelays: [1000],
      webSocketImplementation: /** @type {any} */ (ResumableWebSocket)
    })
    /** @type {string[]} */
    const connectionCloseReasons = []
    /** @type {string[]} */
    const subscriptionCloseReasons = []

    await client.connect()

    const connection = client.openConnection("ChatConnection", {
      onClose: (reason) => {
        expect(client.socket).toBe(undefined)
        connectionCloseReasons.push(reason)
      }
    })
    const subscription = client.subscribeChannel("TickChannel", {
      onClose: (reason) => {
        expect(client.socket).toBe(undefined)
        subscriptionCloseReasons.push(reason)
      }
    })

    await connection.ready
    await subscription.ready
    await client.dropConnection()
    await client.disconnectAndStopReconnect()

    expect(connectionCloseReasons).toEqual(["client_close"])
    expect(subscriptionCloseReasons).toEqual(["client_close"])
    expect(client._connections.has(connection.connectionId)).toBe(false)
    expect(client._channelSubscriptions.has(subscription.subscriptionId)).toBe(false)
    expect(client._awaitingResume).toBe(false)
  })

  it("closes every preserved handle when a close callback throws", async () => {
    const client = new SnapReqWebSocketClient({
      url: "ws://resumable.test",
      autoReconnect: true,
      reconnectDelays: [1000],
      webSocketImplementation: /** @type {any} */ (ResumableWebSocket)
    })
    const callbackError = new Error("close callback failed")
    /** @type {string[]} */
    const subscriptionCloseReasons = []

    await client.connect()
    const connection = client.openConnection("ChatConnection", {
      onClose: () => { throw callbackError }
    })
    const subscription = client.subscribeChannel("TickChannel", {
      onClose: (reason) => subscriptionCloseReasons.push(reason)
    })

    await connection.ready
    await subscription.ready
    await client.dropConnection()
    await expect(() => client.disconnectAndStopReconnect()).toThrow(/close callback failed/)

    expect(subscriptionCloseReasons).toEqual(["client_close"])
    expect(connection.isClosed()).toBe(true)
    expect(subscription.isClosed()).toBe(true)
  })

  it("waits for a failed reconnect socket after a replacement connection opens", async () => {
    let connectionAttempt = 0
    /** @type {(() => void) | undefined} */
    let resolveReconnectCloseStarted
    /** @type {GatedReconnectWebSocket | undefined} */
    let reconnectSocket
    /** @type {Promise<void>} */
    const reconnectCloseStarted = new Promise((resolve) => { resolveReconnectCloseStarted = resolve })

    class GatedReconnectWebSocket extends ResumableWebSocket {
      constructor() {
        super()
        connectionAttempt += 1
        this.failConnection = connectionAttempt === 2
      }

      close() {
        if (!this.failConnection) {
          super.close()
          return
        }

        this.readyState = this.CLOSING
        reconnectSocket = this
        if (!resolveReconnectCloseStarted) throw new Error("Reconnect close-start resolver was not initialized")
        resolveReconnectCloseStarted()
      }

      finishClose() {
        this.readyState = this.CLOSED
        this.dispatchEvent(new Event("close"))
      }

      send(raw) {
        const message = JSON.parse(raw)

        if (message.type === "session-resume") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({type: "session-resumed", sessionId: message.sessionId})
          })))
          return
        }

        super.send(raw)
      }
    }

    const client = new SnapReqWebSocketClient({
      url: "ws://failed-reconnect.test",
      autoReconnect: true,
      reconnectDelays: [0],
      webSocketImplementation: /** @type {any} */ (GatedReconnectWebSocket)
    })
    /** @type {string[]} */
    const connectionCloseReasons = []
    /** @type {string[]} */
    const subscriptionCloseReasons = []

    await client.connect()
    const connection = client.openConnection("ChatConnection", {
      onClose: (reason) => connectionCloseReasons.push(reason)
    })
    const subscription = client.subscribeChannel("TickChannel", {
      onClose: (reason) => subscriptionCloseReasons.push(reason)
    })

    await connection.ready
    await subscription.ready
    await client.dropConnection()
    await reconnectCloseStarted
    if (!reconnectSocket) throw new Error("Failed reconnect socket did not start closing")

    expect(reconnectSocket.readyState).toBe(reconnectSocket.CLOSING)
    await client.connect({autoReconnect: false})
    expect(client.socket).not.toBe(reconnectSocket)

    let disconnectResolved = false
    const disconnect = client.disconnectAndStopReconnect().then(() => { disconnectResolved = true })

    await delay(0)
    expect(connectionCloseReasons).toEqual(["client_close"])
    expect(subscriptionCloseReasons).toEqual(["client_close"])
    expect(disconnectResolved).toBe(false)

    reconnectSocket.finishClose()
    await disconnect
    expect(disconnectResolved).toBe(true)
  })

  it("waits for a failed reconnect socket when a close callback throws", async () => {
    let connectionAttempt = 0
    /** @type {(() => void) | undefined} */
    let resolveReconnectCloseStarted
    /** @type {GatedCallbackWebSocket | undefined} */
    let reconnectSocket
    const reconnectCloseStarted = new Promise((resolve) => { resolveReconnectCloseStarted = resolve })

    class GatedCallbackWebSocket extends ResumableWebSocket {
      constructor() {
        super()
        connectionAttempt += 1
        this.failConnection = connectionAttempt > 1
      }

      close() {
        if (!this.failConnection) {
          super.close()
          return
        }

        this.readyState = this.CLOSING
        reconnectSocket = this
        if (!resolveReconnectCloseStarted) throw new Error("Reconnect close-start resolver was not initialized")
        resolveReconnectCloseStarted()
      }

      finishClose() {
        this.readyState = this.CLOSED
        this.dispatchEvent(new Event("close"))
      }
    }

    const client = new SnapReqWebSocketClient({
      url: "ws://failed-reconnect-callback.test",
      autoReconnect: true,
      reconnectDelays: [0],
      webSocketImplementation: /** @type {any} */ (GatedCallbackWebSocket)
    })
    const callbackError = new Error("close callback failed")
    /** @type {string[]} */
    const subscriptionCloseReasons = []

    await client.connect()
    const connection = client.openConnection("ChatConnection", {
      onClose: () => { throw callbackError }
    })
    const subscription = client.subscribeChannel("TickChannel", {
      onClose: (reason) => subscriptionCloseReasons.push(reason)
    })

    await connection.ready
    await subscription.ready
    await client.dropConnection()
    await reconnectCloseStarted
    if (!reconnectSocket) throw new Error("Failed reconnect socket did not start closing")

    let disconnectError
    let disconnectSettled = false
    const disconnect = client.disconnectAndStopReconnect().then(
      () => { disconnectSettled = true },
      (error) => {
        disconnectError = error
        disconnectSettled = true
      }
    )

    await delay(0)
    const settledBeforeSocketClosed = disconnectSettled
    reconnectSocket.finishClose()
    await disconnect

    expect(settledBeforeSocketClosed).toBe(false)
    expect(disconnectError).toBe(callbackError)
    expect(subscriptionCloseReasons).toEqual(["client_close"])
  })

  it("preserves a reconnect started by an explicit close callback", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    /** @type {Promise<void> | undefined} */
    let reconnectPromise

    await client.connect()
    const connection = client.openConnection("ChatConnection", {
      onClose: () => { reconnectPromise = client.connect() }
    })

    await connection.ready
    await client.close()
    if (!reconnectPromise) throw new Error("Close callback did not start reconnect")
    await reconnectPromise

    expect(client.isOpen()).toBe(true)
    await client.close()
  })

  it("re-establishes live handles exactly once on the fresh session when resume reports session gone", async () => {
    const resumeId = "live-handles"
    const client = new SnapReqWebSocketClient({
      autoReconnect: true,
      reconnectDelays: [1],
      url: `${server.url}?session-gone-on-resume=1&manual-session-gone=${resumeId}`
    })

    await client.connect()
    const initialSessionId = client._sessionId
    let connectionOpenCount = 0
    const connection = client.openConnection("EchoConnection", {
      onConnect: () => { connectionOpenCount += 1 }
    })

    await connection.ready
    const resumeReceived = server.waitForSessionResume(resumeId)
    await client.dropConnection()
    await resumeReceived

    const pendingConnection = client.openConnection("PendingConnection")
    const subscription = client.subscribeChannel("TickChannel")
    const pendingConnectionReady = pendingConnection.ready
    const subscriptionReady = subscription.ready
    server.releaseSessionGone(resumeId)

    try {
      await pendingConnectionReady
      await subscriptionReady

      const pendingConnectionOpenMessages = server.receivedMessages.filter((message) => (
        message.type === "connection-open" && message.connectionId === pendingConnection.connectionId
      ))

      expect(connectionOpenCount).toBe(2)
      expect(connection.isConnected()).toBe(true)
      expect(pendingConnectionOpenMessages.length).toBe(1)
      expect(pendingConnection.isConnected()).toBe(true)
      expect(subscription.isSubscribed()).toBe(true)
      expect(subscription.isClosed()).toBe(false)
      expect(client._sessionId).not.toBe(initialSessionId)
      expect(client._sessionId ?? "").toMatch(/^session-\d+$/)
    } finally {
      connection.close()
      pendingConnection.close()
      subscription.close()
      await client.close()
    }
  })

  it("keeps shared legacy subscription readiness alive when one callback times out", async () => {
    const client = new SnapReqWebSocketClient({url: server.url, autoReconnect: false})
    /** @type {any[]} */
    const received = []
    const first = client.subscribe("delayed-updates", {timeoutMs: 10}, () => received.push("first"))
    const second = client.subscribe("delayed-updates", {timeoutMs: 200}, () => received.push("second"))

    await expect(() => first.ready).toThrow(TimeoutError)
    await second.ready
    await delay(10)

    expect(received).toEqual(["second"])
    expect([...client.listeners.values()].find((listener) => listener.channel === "delayed-updates")?.callbacks.size).toBe(1)
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
    /** @type {unknown} */
    let firstError
    /** @type {unknown} */
    let secondError

    try {
      await first.ready
    } catch (error) {
      firstError = error
    }

    try {
      await second.ready
    } catch (error) {
      secondError = error
    }

    expect(firstError).toBe("first-cancelled")
    expect(secondError).toBe("second-cancelled")
    await delay(70)

    expect(server.receivedMessages.some((message) => message.requestUrl === `/?delay-session=${requestUrl.split("=")[1]}` && message.type === "subscribe")).toBe(false)
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

      /** @type {unknown} */
      let waitingError

      try {
        await waiting
      } catch (error) {
        waitingError = error
      }

      if (control === "timeout") expect(waitingError).toBeInstanceOf(TimeoutError)
      else expect(waitingError).toBe(reason)

      await delay(10)

      expect(failed.isClosed()).toBe(true)
      expect(client._channelSubscriptions.has(failed.subscriptionId)).toBe(false)
      expect(server.receivedMessages.some((message) => message.type === "channel-unsubscribe" && message.subscriptionId === failed.subscriptionId)).toBe(true)
      expect(survivor.isSubscribed()).toBe(true)
      expect(client.isOpen()).toBe(true)
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

    await expect(() => failed.ready).toThrow(TimeoutError)
    await delay(10)

    expect(failed.isClosed()).toBe(true)
    expect(client._channelSubscriptions.has(failed.subscriptionId)).toBe(false)
    expect(server.receivedMessages.some((message) => message.type === "channel-unsubscribe" && message.subscriptionId === failed.subscriptionId)).toBe(true)
    expect(survivor.isSubscribed()).toBe(true)
    expect(client.isOpen()).toBe(true)
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

      /** @type {unknown} */
      let readinessError

      try {
        await failed.ready
      } catch (error) {
        readinessError = error
      }

      if (control === "timeout") expect(readinessError).toBeInstanceOf(TimeoutError)
      else expect(readinessError).toBe(reason)

      await delay(10)

      expect(failed.isClosed()).toBe(true)
      expect(client._connections.has(failed.connectionId)).toBe(false)
      expect(server.receivedMessages.some((message) => message.type === "connection-close" && message.connectionId === failed.connectionId)).toBe(true)
      expect(survivor.isConnected()).toBe(true)
      expect(client.isOpen()).toBe(true)
      survivor.close()
      await client.close()
    })
  }
})
