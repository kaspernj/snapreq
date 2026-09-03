// @ts-check

import SnapReqWebSocketConnection from "./websocket-connection.js"
import SnapReqWebSocketChannel from "./websocket-channel.js"
import {runControlled} from "../control.js"

const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000]

/**
 * A small WebSocket client that mirrors simple HTTP-style calls and channel
 * subscriptions over `globalThis.WebSocket`, so the same code runs on web, Expo
 * / React Native and Node. Supports optional auto-reconnect with exponential
 * backoff, session resumption and listener re-subscription.
 *
 * Response bodies are returned as raw parsed JSON; apps that need their own
 * (de)serialization should apply it around `post`/`get` and the response
 * `json()`.
 */
export default class SnapReqWebSocketClient {
  /** @type {Map<string, {reject: (error: unknown) => void, resolve: (response: SnapReqWebSocketResponse) => void}>} */
  pendingRequests
  /** @type {Map<string, {reject: (error: unknown) => void, resolve: (value?: void) => void}>} */
  pendingSubscriptions
  /** @type {Map<string, {callbacks: Set<(payload: any) => void>, channel: string, params: Record<string, any> | undefined, ready: Promise<void>}>} */
  listeners

  /**
   * @param {object} args - Options object.
   * @param {string} args.url - Full WebSocket URL, e.g. `ws://localhost:3006/websocket`.
   * @param {boolean} [args.autoReconnect] - Enable auto-reconnect with exponential backoff.
   * @param {boolean} [args.debug] - Whether to log debug output.
   * @param {{getIsOnline?: () => boolean | Promise<boolean>, subscribe?: (callback: (isOnline: boolean) => void) => (() => void) | {remove: () => void}}} [args.networkMonitor] - Optional online-state adapter. When provided, auto-reconnect can wait for the network to report online before reconnecting, and open sockets are closed when the monitor reports offline.
   * @param {number[]} [args.reconnectDelays] - Backoff delays in ms (default: [1000, 2000, 4000, 8000, 15000]).
   * @param {{get: () => string | null | undefined | Promise<string | null | undefined>, set: (sessionId: string) => void | Promise<void>, clear: () => void | Promise<void>}} [args.sessionStore] - Optional sessionId persistence hook surviving reloads (localStorage, a cookie, SQLite, etc.).
   * @param {(value: any) => any} [args.deserialize] - Optional transform applied to a response body inside `response.json()`. Lets an app re-hydrate its own wire format. Defaults to identity.
   * @param {typeof globalThis.WebSocket} [args.webSocketImplementation] - WebSocket constructor to use instead of `globalThis.WebSocket`. Inject Node's `ws` here to get real WS ping/pong heartbeats and socket `unref` (the browser/undici global exposes neither).
   * @param {number} [args.heartbeatIntervalMs] - When > 0 and the WebSocket implementation supports `.ping()` (Node `ws`), send a protocol ping every this-many ms and drop the socket if the peer did not pong since the previous ping (so a vanished peer is noticed within ~2× this interval). Default 0 (disabled).
   * @param {boolean} [args.unref] - When the underlying socket exposes `unref()` (Node `ws`), unref it so an idle connection can never keep the process/event loop alive on its own. Best-effort no-op on browser/undici. Default false.
   */
  constructor({autoReconnect = true, debug = false, deserialize, heartbeatIntervalMs = 0, networkMonitor, reconnectDelays, sessionStore, unref = false, url, webSocketImplementation} = /** @type {any} */ ({})) {
    /** @type {typeof globalThis.WebSocket} */
    const WebSocketImplementation = webSocketImplementation || globalThis.WebSocket

    if (!WebSocketImplementation) throw new Error("WebSocket implementation is not available")
    if (!url) throw new Error("SnapReqWebSocketClient requires a url")

    /** @type {(value: any) => any} */
    this._deserialize = deserialize || ((value) => value)
    /** @type {boolean} */
    this.autoReconnect = autoReconnect
    this.debug = debug
    /** @type {typeof globalThis.WebSocket} */
    this._WebSocket = WebSocketImplementation
    /** @type {boolean} */
    this._unref = unref
    /** @type {number} - ms between liveness pings; 0 disables the heartbeat. */
    this._heartbeatIntervalMs = heartbeatIntervalMs
    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatTimer = null
    /** @type {number | null} */
    this.disconnectedSince = null
    this.pendingRequests = new Map()
    this.pendingSubscriptions = new Map()
    /** @type {number} */
    this.reconnectAttempt = 0
    /** @type {number} */
    this.connectionAttempts = 0
    /** @type {number[]} */
    this.reconnectDelays = reconnectDelays || DEFAULT_RECONNECT_DELAYS
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null
    this.url = url
    this.listeners = new Map()
    this.nextID = 1
    /** @type {(() => void | Promise<void>) | null} */
    this.onReconnect = null

    /** @type {Record<string, any>} */
    this._metadata = {}

    /** @type {Map<string, SnapReqWebSocketConnection>} */
    this._connections = new Map()

    /** @type {Map<string, SnapReqWebSocketChannel>} */
    this._channelSubscriptions = new Map()

    this._nextConnectionIdSeq = 1
    this._nextSubscriptionIdSeq = 1

    /** @type {string | null} - sessionId received from `session-established`; sent on reconnect for resumption. */
    this._sessionId = null

    /** @type {boolean} - true between a reconnect and the session-resumed / session-gone reply. */
    this._awaitingResume = false

    /** @type {boolean} - true once the current socket has an active session ready for app messages. */
    this._sessionReady = false

    /** @type {string | null} - provisional session id announced before a resume attempt finishes. */
    this._pendingSessionId = null

    /** @type {Promise<void> | null} */
    this._sessionReadyPromise = null

    /** @type {(() => void) | null} */
    this._resolveSessionReady = null

    /** @type {unknown | null} */
    this._sessionReadyError = null

    /** @type {{get: () => string | null | undefined | Promise<string | null | undefined>, set: (sessionId: string) => void | Promise<void>, clear: () => void | Promise<void>} | undefined} */
    this._sessionStore = sessionStore
    /** @type {boolean} - true once the sessionStore has been consulted for a restored id. */
    this._sessionStoreRestored = false

    /** @type {{getIsOnline?: () => boolean | Promise<boolean>, subscribe?: (callback: (isOnline: boolean) => void) => (() => void) | {remove: () => void}} | undefined} */
    this._networkMonitor = networkMonitor

    /** @type {null | (() => void) | {remove: () => void}} */
    this._networkMonitorSubscription = null

    /** @type {boolean} */
    this._waitingForOnline = false

    /** @type {number} - Operations currently depending on the shared in-flight connect. */
    this._connectWaiters = 0

    /** @type {WeakSet<object>} - Sockets whose terminal lifecycle has already been processed. */
    this._closedSockets = new WeakSet()

    /** @type {WeakSet<object>} - Sockets closed through the client's explicit shutdown API. */
    this._clientClosingSockets = new WeakSet()

    /** @type {Set<WebSocket>} - Failed sockets still waiting for their terminal close event. */
    this._closingSockets = new Set()
  }

  /** @returns {boolean} - Whether the socket is open. */
  isOpen() {
    return Boolean(this.socket && this.socket.readyState === this.socket.OPEN)
  }

  /** @returns {boolean} - Whether the session is ready for app messages. */
  isSessionReady() {
    return this._sessionReady
  }

  /**
   * Opens a 1:1 connection of the given type against the server. Requires the
   * socket to already be connected (call `connect()` first).
   * @param {string} connectionType - Name the server registered the class under.
   * @param {{params?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal, onConnect?: () => void, onMessage?: (body: any) => void, onDisconnect?: () => void, onResume?: () => void, onClose?: (reason: string) => void}} [options] - Connection options.
   * @returns {SnapReqWebSocketConnection} - The connection handle.
   */
  openConnection(connectionType, options = {}) {
    if (!this.isOpen()) throw new Error("Websocket is not open; call connect() first")

    const connectionId = `c${this._nextConnectionIdSeq++}`
    const connection = new SnapReqWebSocketConnection({
      client: this,
      connectionId,
      connectionType,
      params: options.params,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onConnect: options.onConnect,
      onMessage: options.onMessage,
      onDisconnect: options.onDisconnect,
      onResume: options.onResume,
      onClose: options.onClose
    })

    this._connections.set(connectionId, connection)
    this._sendConnectionOpen(connection)

    return connection
  }

  /**
   * Drops a connection handle from the registry.
   * @param {string} connectionId - The connection id.
   * @returns {void}
   */
  _removeConnection(connectionId) {
    this._connections.delete(connectionId)
  }

  /**
   * @param {SnapReqWebSocketConnection} connection - The connection to open.
   * @returns {void}
   */
  _sendConnectionOpen(connection) {
    if (!this.isOpen() || !this.isSessionReady() || !connection._needsOpen()) return

    try {
      this._sendMessage({
        type: "connection-open",
        connectionId: connection.connectionId,
        connectionType: connection.connectionType,
        params: connection.params
      })
      connection._markOpenSent()
    } catch (error) {
      if (!this.isOpen()) throw error

      this._connections.delete(connection.connectionId)
      connection._handleClosed(`send_failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @returns {void} */
  _sendPendingConnections() {
    for (const connection of this._connections.values()) this._sendConnectionOpen(connection)
  }

  /**
   * Subscribes to a named channel. If the socket is not yet open, the
   * subscription is queued and sent once a connection is established.
   * @param {string} channelType - Name the server registered the channel under.
   * @param {{params?: Record<string, any>, lastEventId?: string, timeoutMs?: number, signal?: AbortSignal, onMessage?: (body: any) => void, onDisconnect?: () => void, onResume?: () => void, onClose?: (reason: string) => void}} [options] - Subscription options.
   * @returns {SnapReqWebSocketChannel} - The subscription handle.
   */
  subscribeChannel(channelType, options = {}) {
    const subscriptionId = `s${this._nextSubscriptionIdSeq++}`
    const subscription = new SnapReqWebSocketChannel({
      client: this,
      subscriptionId,
      channelType,
      lastEventId: options.lastEventId,
      params: options.params,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onMessage: options.onMessage,
      onDisconnect: options.onDisconnect,
      onResume: options.onResume,
      onClose: options.onClose
    })

    this._channelSubscriptions.set(subscriptionId, subscription)
    this._sendChannelSubscribe(subscription)

    return subscription
  }

  /**
   * @param {string} subscriptionId - The subscription id.
   * @returns {void}
   */
  _removeChannelSubscription(subscriptionId) {
    this._channelSubscriptions.delete(subscriptionId)
  }

  /**
   * @param {SnapReqWebSocketChannel} subscription - The subscription to send.
   * @returns {void}
   */
  _sendChannelSubscribe(subscription) {
    if (!this.isOpen() || !this.isSessionReady() || !subscription._needsSubscribe()) return

    // Send first and only mark as sent on success. If the socket closes between
    // `isOpen()` and `send()` and `_sendMessage` throws, `_subscribeSent` must
    // stay false so the reconnect path's `_sendPendingChannelSubscriptions()`
    // can retry.
    try {
      this._sendMessage({
        type: "channel-subscribe",
        subscriptionId: subscription.subscriptionId,
        channelType: subscription.channelType,
        params: subscription.params,
        ...(subscription.lastEventId ? {lastEventId: subscription.lastEventId} : {})
      })
      subscription._markSubscribeSent()
    } catch (error) {
      // Transient closed-socket race: leave the subscription retryable so
      // `_sendPendingChannelSubscriptions()` can resend after reconnect.
      if (!this.isOpen()) throw error

      // Non-recoverable send failure on an open socket (e.g. JSON.stringify
      // failing on BigInt/cyclic params). Close the subscription and remove it
      // so it cannot poison future `_sendPendingChannelSubscriptions()` loops.
      this._channelSubscriptions.delete(subscription.subscriptionId)
      subscription._handleClosed(`send_failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @returns {void} */
  _sendPendingChannelSubscriptions() {
    for (const subscription of this._channelSubscriptions.values()) {
      this._sendChannelSubscribe(subscription)
    }
  }

  /** @returns {Promise<boolean>} - Whether the network reports online. */
  async _isOnline() {
    if (!this._networkMonitor?.getIsOnline) return true

    try {
      return await this._networkMonitor.getIsOnline() !== false
    } catch (error) {
      this._debug("networkMonitor.getIsOnline failed", error)
      return true
    }
  }

  /** @returns {Promise<boolean>} - Whether reconnect should wait for online. */
  async _shouldWaitForOnline() {
    if (!this._networkMonitor) return false

    const isOnline = await this._isOnline()

    if (isOnline) return false

    this._waitingForOnline = true
    this._cancelPendingReconnect()
    return true
  }

  /** @returns {void} */
  _ensureNetworkMonitorSubscription() {
    if (!this._networkMonitor?.subscribe || this._networkMonitorSubscription) return

    this._networkMonitorSubscription = this._networkMonitor.subscribe((isOnline) => {
      if (!this.autoReconnect) return

      if (isOnline) {
        if (!this._waitingForOnline) return

        this._waitingForOnline = false
        void this._attemptReconnect()
        return
      }

      this._waitingForOnline = true
      this._cancelPendingReconnect()

      if (this.isOpen()) {
        void this.dropConnection()
      }
    })
  }

  /** @returns {void} */
  _teardownNetworkMonitorSubscription() {
    if (!this._networkMonitorSubscription) return

    if (typeof this._networkMonitorSubscription === "function") {
      this._networkMonitorSubscription()
    } else {
      this._networkMonitorSubscription.remove()
    }

    this._networkMonitorSubscription = null
  }

  /**
   * Sets a global metadata value that is sent to the server. When the socket is
   * open, a metadata update message is sent immediately.
   * @param {string} key - Metadata key.
   * @param {any} value - Metadata value (null to clear).
   * @returns {void}
   */
  setMetadata(key, value) {
    if (value === null || value === undefined) {
      delete this._metadata[key]
    } else {
      this._metadata[key] = value
    }

    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this._sendMessage({type: "metadata", data: {...this._metadata}})
    }
  }

  /** @returns {Record<string, any>} - Current metadata. */
  getMetadata() {
    return {...this._metadata}
  }

  /**
   * Ensures a WebSocket connection is open. Auto-reconnect and online gating are
   * enabled by default.
   * @param {{autoReconnect?: boolean, waitForOnline?: boolean, resetReconnectState?: boolean, timeoutMs?: number, signal?: AbortSignal}} [options] - Connect options.
   * @returns {Promise<void>} - Resolves once connected and the session is ready.
   */
  async connect({autoReconnect = this.autoReconnect, waitForOnline = true, resetReconnectState = true, timeoutMs, signal} = {}) {
    this._connectWaiters += 1

    try {
      await runControlled({timeoutMs, signal}, () => this._connect({autoReconnect, waitForOnline, resetReconnectState}))
    } catch (error) {
      if (this.socket && this._connectWaiters === 1) {
        const failedSocket = this.socket

        failedSocket.removeEventListener("message", this.onMessage)
        failedSocket.removeEventListener("close", this.onClose)
        this._stopSocketKeepalive()
        this._closingSockets.add(failedSocket)
        const failedSocketClose = this._closeSocketAndWait(failedSocket)

        try {
          this._handleSocketClose(failedSocket, error, false)
        } finally {
          try {
            await failedSocketClose
          } finally {
            this._closingSockets.delete(failedSocket)
            if (this.socket === failedSocket) this.socket = undefined
          }
        }
      }

      throw error
    } finally {
      this._connectWaiters -= 1
    }
  }

  /**
   * @param {object} [options] - Internal connect options.
   * @param {boolean} [options.autoReconnect] - Whether reconnect remains enabled.
   * @param {boolean} [options.waitForOnline] - Whether to honor the online gate.
   * @param {boolean} [options.resetReconnectState] - Whether to reset backoff state.
   * @returns {Promise<void>} - Opens the socket and waits for session readiness.
   */
  async _connect({autoReconnect = this.autoReconnect, waitForOnline = true, resetReconnectState = true} = {}) {
    this.autoReconnect = autoReconnect

    if (this.autoReconnect) {
      this._ensureNetworkMonitorSubscription()
    } else {
      this._waitingForOnline = false
      this._cancelPendingReconnect()
      this._teardownNetworkMonitorSubscription()
    }

    if (waitForOnline && this.autoReconnect && !await this._isOnline()) {
      this._waitingForOnline = true
      return
    }

    if (resetReconnectState) {
      this.reconnectAttempt = 0
    }

    if (this.socket && this.socket.readyState === this.socket.OPEN) return await this._waitForSessionReady()
    if (this.connectPromise) return this.connectPromise

    this._resetSessionReadyState()
    this._waitingForOnline = false
    this.connectionAttempts += 1

    this.connectPromise = new Promise((resolve, reject) => {
      this.socket = new this._WebSocket(this.url)

      const cleanup = () => {
        this.socket?.removeEventListener("open", onOpen)
        this.socket?.removeEventListener("error", onError)
        this.socket?.removeEventListener("close", onCloseBeforeOpen)
      }

      const onOpen = () => {
        cleanup()
        this._startSocketKeepalive()
        resolve(undefined)
      }
      const onError = (/** @type {Event & {error?: unknown}} */ event) => {
        cleanup()
        const error = event?.error || new Error("Websocket connection error")
        reject(error)
      }
      const onCloseBeforeOpen = () => {
        cleanup()
        reject(new Error("Websocket closed before opening"))
      }

      this.socket.addEventListener("open", onOpen)
      this.socket.addEventListener("error", onError)
      this.socket.addEventListener("close", onCloseBeforeOpen, {once: true})
      this.socket.addEventListener("message", this.onMessage)
      this.socket.addEventListener("close", this.onClose)
    })

    await this.connectPromise

    // Cold restore from external persistence (sessionStore) on the very first
    // connect: apps wire this up to survive a full page reload.
    if (!this._sessionId && !this._sessionStoreRestored && this._sessionStore) {
      this._sessionStoreRestored = true

      try {
        const storedId = await this._sessionStore.get()

        if (typeof storedId === "string" && storedId.length > 0) {
          this._sessionId = storedId
        }
      } catch (error) {
        this._debug("sessionStore.get failed", error)
      }
    }

    // If we have a cached sessionId from a prior connect, ask the server to
    // resume it. The server replies with either `session-resumed` (state
    // preserved) or `session-gone` (start fresh).
    if (this._sessionId) {
      this._awaitingResume = true
      this._sendMessage({type: "session-resume", sessionId: this._sessionId})
      // Fire onDisconnect on live handles so apps can pause UI work until
      // session-resumed / session-gone arrives.
      for (const connection of this._connections.values()) connection._handleDisconnected()
      for (const subscription of this._channelSubscriptions.values()) subscription._handleDisconnected()
    }

    if (Object.keys(this._metadata).length > 0) {
      this._sendMessage({type: "metadata", data: {...this._metadata}})
    }

    await this._waitForSessionReady()
    this.disconnectedSince = null
  }

  /**
   * Starts closing a socket when needed and waits for its terminal event.
   * @param {WebSocket} socket - Socket to close.
   * @returns {Promise<void>} - Resolves once the socket is closed.
   */
  async _closeSocketAndWait(socket) {
    if (socket.readyState === socket.CLOSED) return

    await new Promise((resolve) => {
      socket.addEventListener("close", () => resolve(undefined), {once: true})
      if (socket.readyState !== socket.CLOSING) socket.close()
    })
  }

  /**
   * Closes the WebSocket and clears pending state.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async close() {
    this.autoReconnect = false
    this._waitingForOnline = false
    this._cancelPendingReconnect()
    this._teardownNetworkMonitorSubscription()
    this._stopSocketKeepalive()

    const socket = this.socket
    const socketsToClose = new Set(this._closingSockets)

    if (socket) socketsToClose.add(socket)

    if (!socket) {
      this.connectPromise = undefined
      this._resetSessionReadyState()
    }

    if (!socket || this._closedSockets.has(socket) || socket.readyState === socket.CLOSED) {
      let handleCloseError
      let handleCloseFailed = false

      try {
        this._closeSessionHandles("client_close")
      } catch (error) {
        handleCloseError = error
        handleCloseFailed = true
      }

      await Promise.all([...socketsToClose].map((closingSocket) => this._closeSocketAndWait(closingSocket)))

      if (socket && this.socket === socket) {
        this.socket = undefined
        this.connectPromise = undefined
        this._resetSessionReadyState()
      }

      if (handleCloseFailed) throw handleCloseError
      return
    }

    this._clientClosingSockets.add(socket)
    await Promise.all([...socketsToClose].map((closingSocket) => this._closeSocketAndWait(closingSocket)))

    if (this.socket === socket) {
      this.socket = undefined
      this.connectPromise = undefined
      this._resetSessionReadyState()
    }
  }

  /**
   * Disables auto-reconnect and closes the WebSocket.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async disconnectAndStopReconnect() {
    await this.close()
  }

  /**
   * Closes the raw socket without disabling auto-reconnect. Used by tests to
   * simulate an unexpected network drop.
   * @returns {Promise<void>} - Resolves once the socket has closed.
   */
  async dropConnection() {
    if (!this.socket) return

    await new Promise((resolve) => {
      this.socket?.addEventListener("close", () => resolve(undefined))
      this.socket?.close()
    })

    this.connectPromise = undefined
    this._resetSessionReadyState()
  }

  /**
   * Performs a POST request over the WebSocket.
   * @param {string} path - Path.
   * @param {any} [body] - Request body.
   * @param {{headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal}} [options] - Request options such as headers and operation controls.
   * @returns {Promise<SnapReqWebSocketResponse>} - The response.
   */
  async post(path, body, options = {}) {
    return await this.request("POST", path, {...options, body})
  }

  /**
   * Performs a GET request over the WebSocket.
   * @param {string} path - Path.
   * @param {{headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal}} [options] - Request options such as headers and operation controls.
   * @returns {Promise<SnapReqWebSocketResponse>} - The response.
   */
  async get(path, options = {}) {
    return await this.request("GET", path, options)
  }

  /**
   * Subscribes to a channel for server-sent events.
   * @param {string} channel - Channel name.
   * @param {(payload: any) => void} callback - Callback function.
   * @returns {() => void} - Unsubscribe function.
   */
  on(channel, callback) {
    return this.subscribe(channel, {}, callback)
  }

  /**
   * Returns a snapshot of the client's connection state.
   * @returns {{disconnectedSince: number | null, isOpen: boolean, listenerCount: number}} - State snapshot.
   */
  state() {
    return {
      disconnectedSince: this.disconnectedSince,
      isOpen: !!this.socket && this.socket.readyState === this.socket.OPEN,
      listenerCount: this.listeners.size + this._channelSubscriptions.size
    }
  }

  /**
   * Subscribes to a channel for server-sent events with optional params.
   * @param {string} channel - Channel name.
   * @param {{lastEventId?: string, params?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal}} options - Subscription options.
   * @param {(payload: any, message?: Record<string, any>) => void} callback - Callback function.
   * @returns {(() => void) & {ready: Promise<void>}} - Unsubscribe function with readiness promise.
   */
  subscribe(channel, options, callback) {
    const params = options?.params
    const lastEventId = options?.lastEventId
    const subscriptionKey = this._subscriptionKey(channel, params)

    if (!this.listeners.has(subscriptionKey)) {
      /** @type {((value?: void) => void) | undefined} */
      let resolveReady
      /** @type {((error: unknown) => void) | undefined} */
      let rejectReady
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })

      this.listeners.set(subscriptionKey, {
        callbacks: new Set(),
        channel,
        params,
        ready
      })
      this.pendingSubscriptions.set(subscriptionKey, {
        reject: rejectReady || (() => {}),
        resolve: resolveReady || (() => {})
      })

      void this.connect().then(() => {
        const currentListener = this.listeners.get(subscriptionKey)

        if (currentListener?.ready !== ready || currentListener.callbacks.size === 0) return
        this._sendMessage({channel, lastEventId, params, type: "subscribe"})
      }).catch((error) => this._debug("Subscribe failed", error))
    }

    const listenerEntry = this.listeners.get(subscriptionKey)

    if (!listenerEntry) throw new Error("Listeners map not initialized")

    listenerEntry.callbacks.add(callback)

    const unsubscribe = () => {
      listenerEntry.callbacks.delete(callback)

      if (listenerEntry.callbacks.size === 0) {
        this.listeners.delete(subscriptionKey)
        this.pendingSubscriptions.delete(subscriptionKey)
      }
    }

    unsubscribe.ready = runControlled(options || {}, () => listenerEntry.ready).catch((error) => {
      listenerEntry.callbacks.delete(callback)
      if (listenerEntry.callbacks.size === 0) {
        this.listeners.delete(subscriptionKey)
        this.pendingSubscriptions.delete(subscriptionKey)
      }

      throw error
    })

    return unsubscribe
  }

  /**
   * Subscribes to a channel and waits until the server acknowledges it.
   * @param {string} channel - Channel name.
   * @param {{lastEventId?: string, params?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal}} options - Subscription options.
   * @param {(payload: any, message?: Record<string, any>) => void} callback - Callback function.
   * @returns {Promise<(() => void) & {ready: Promise<void>}>} - Ready unsubscribe handle.
   */
  async subscribeAndWait(channel, options, callback) {
    const unsubscribe = this.subscribe(channel, options, callback)

    await unsubscribe.ready

    return unsubscribe
  }

  /**
   * @param {string} method - HTTP method.
   * @param {string} path - Path.
   * @param {object} [options] - Options object.
   * @param {any} [options.body] - Request body.
   * @param {Record<string, string>} [options.headers] - Header list.
   * @param {number} [options.timeoutMs] - Deadline for connect/session readiness and the response.
   * @param {AbortSignal} [options.signal] - Cancels only this pending request.
   * @returns {Promise<SnapReqWebSocketResponse>} - The response.
   */
  async request(method, path, {body, headers, timeoutMs, signal} = {}) {
    await this.connect({timeoutMs, signal})

    const id = `ws-${this.nextID++}`
    const payload = {
      body,
      headers,
      id,
      method,
      path,
      type: "request"
    }

    return await runControlled({timeoutMs, signal}, () => new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {resolve, reject})

      try {
        this._sendMessage(payload)
      } catch (error) {
        this.pendingRequests.delete(id)
        reject(error)
      }
    })).finally(() => this.pendingRequests.delete(id))
  }

  /**
   * @param {MessageEvent<any>} event - Event payload.
   * @returns {void}
   */
  onMessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data?.toString?.()

    if (!raw) return

    /** @type {Record<string, any>} */
    let message

    try {
      message = JSON.parse(raw)
    } catch (error) {
      this._debug("Failed to parse websocket message", error)
      return
    }

    const {type} = message

    if (type === "response") {
      const {id} = message
      const pending = id ? this.pendingRequests.get(id) : undefined

      if (pending) {
        this.pendingRequests.delete(id)
        pending.resolve(new SnapReqWebSocketResponse(message, this._deserialize))
      } else {
        this._debug(`No pending request for response id ${id}`)
      }
    } else if (type === "subscribed") {
      const subscriptionKey = this._subscriptionKey(message.channel, message.params)
      const pendingSubscription = this.pendingSubscriptions.get(subscriptionKey)

      if (pendingSubscription) {
        this.pendingSubscriptions.delete(subscriptionKey)
        pendingSubscription.resolve()
      }
    } else if (type === "event") {
      const {channel, payload} = message

      for (const listenerEntry of this.listeners.values()) {
        if (listenerEntry.channel !== channel) continue

        listenerEntry.callbacks.forEach((/** @type {(payload: any, message?: Record<string, any>) => void} */ callback) => {
          try {
            callback(payload, message)
          } catch (error) {
            this._debug("Listener error", error)
          }
        })
      }
    } else if (type === "replay-gap") {
      const subscriptionKey = this._subscriptionKey(message.channel, message.params)
      const pendingSubscription = this.pendingSubscriptions.get(subscriptionKey)

      if (pendingSubscription) {
        this.pendingSubscriptions.delete(subscriptionKey)
        pendingSubscription.reject(new Error(`Replay gap for ${message.channel}`))
      }
    } else if (type === "connection-opened") {
      const connection = this._connections.get(message.connectionId)

      connection?._handleOpened()
    } else if (type === "connection-message") {
      const connection = this._connections.get(message.connectionId)

      connection?._handleMessage(message.body)
    } else if (type === "connection-closed") {
      const connection = this._connections.get(message.connectionId)

      if (connection) {
        this._connections.delete(message.connectionId)
        connection._handleClosed(message.reason || "server_close")
      }
    } else if (type === "connection-error") {
      const connection = this._connections.get(message.connectionId)

      if (connection) {
        this._connections.delete(message.connectionId)
        connection._handleClosed(`error: ${message.message || "connection-error"}`)
      }
    } else if (type === "channel-subscribed") {
      const sub = this._channelSubscriptions.get(message.subscriptionId)

      sub?._handleSubscribed()
    } else if (type === "channel-message") {
      const sub = this._channelSubscriptions.get(message.subscriptionId)

      sub?._handleMessage(message.body)
    } else if (type === "channel-unsubscribed") {
      const sub = this._channelSubscriptions.get(message.subscriptionId)

      if (sub) {
        this._channelSubscriptions.delete(message.subscriptionId)
        sub._handleClosed("server_unsubscribe")
      }
    } else if (type === "channel-error") {
      const sub = this._channelSubscriptions.get(message.subscriptionId)

      if (sub) {
        this._channelSubscriptions.delete(message.subscriptionId)
        sub._handleClosed(`error: ${message.message || "channel-error"}`)
      }
    } else if (type === "session-established") {
      this._pendingSessionId = typeof message.sessionId === "string" ? message.sessionId : null

      // First connect: cache sessionId for future resume attempts.
      if (!this._awaitingResume) {
        this._sessionId = this._pendingSessionId
        if (this._sessionId) {
          this._persistSessionId(this._sessionId)
        }

        this._markSessionReady()
        this._sendPendingConnections()
        this._sendPendingChannelSubscriptions()
      }
    } else if (type === "session-resumed") {
      this._awaitingResume = false
      this._pendingSessionId = null
      this._sessionId = message.sessionId
      this._persistSessionId(message.sessionId)
      this._markSessionReady()
      this._sendPendingConnections()
      this._sendPendingChannelSubscriptions()
      // Fire onResume on every live handle so user code knows the session came
      // back with state intact.
      for (const connection of this._connections.values()) connection._handleResumed()
      for (const subscription of this._channelSubscriptions.values()) subscription._handleResumed()
    } else if (type === "session-gone") {
      this._awaitingResume = false
      this._sessionId = this._pendingSessionId
      this._pendingSessionId = null
      if (this._sessionId) this._persistSessionId(this._sessionId)
      else this._clearPersistedSessionId()

      for (const connection of this._connections.values()) connection._handleSessionGone()
      for (const subscription of this._channelSubscriptions.values()) subscription._handleSessionGone()

      this._markSessionReady()
      this._sendPendingConnections()
      this._sendPendingChannelSubscriptions()
    } else if (type === "error" && message.id) {
      const pending = this.pendingRequests.get(message.id)

      if (pending) {
        this.pendingRequests.delete(message.id)
        pending.reject(new Error(message.error || "Unknown websocket error"))
      }
    }
  }

  /**
   * @param {string} channel - Channel name.
   * @param {Record<string, any> | undefined} params - Subscription params.
   * @returns {string} - Stable subscription key.
   */
  _subscriptionKey(channel, params) {
    return JSON.stringify([channel, params || null])
  }

  /**
   * Rejects all pending requests when the socket closes. Schedules reconnect if
   * enabled.
   * @returns {void}
   */
  /**
   * Starts the protocol-level liveness heartbeat and applies socket unref, both
   * best-effort: only the Node `ws` implementation exposes `.ping()`/`.on("pong")`
   * and an unref-able `_socket`, so on browser/undici these are no-ops. The
   * heartbeat lets a client notice a peer that silently went away; unref (plus
   * the unref'd timers) ensures neither the socket nor these timers keep the
   * process/event loop alive on their own once nothing else is pending.
   * @returns {void}
   */
  _startSocketKeepalive() {
    const socket = /** @type {any} */ (this.socket)

    if (!socket) return

    if (this._unref && typeof socket._socket?.unref === "function") {
      socket._socket.unref()
    }

    this._stopSocketKeepalive()

    if (this._heartbeatIntervalMs <= 0 || typeof socket.ping !== "function" || typeof socket.on !== "function") {
      return
    }

    // Standard `ws` heartbeat idiom: each tick, if the peer did not pong since
    // the previous ping, treat it as gone and drop the socket; otherwise arm the
    // next window and ping. A pong (sync or async) clears the flag before the
    // next tick, so a live peer is never dropped.
    let awaitingPong = false

    socket.on("pong", () => { awaitingPong = false })

    this._heartbeatTimer = globalThis.setInterval(() => {
      if (awaitingPong) {
        if (typeof socket.terminate === "function") socket.terminate()
        else socket.close()

        return
      }

      awaitingPong = true

      try {
        socket.ping()
      } catch {
        // Socket already closing; the close handler will stop the heartbeat.
      }
    }, this._heartbeatIntervalMs)

    if (typeof this._heartbeatTimer.unref === "function") this._heartbeatTimer.unref()
  }

  /**
   * Stops the liveness heartbeat timer. Safe to call repeatedly.
   * @returns {void}
   */
  _stopSocketKeepalive() {
    if (this._heartbeatTimer) {
      globalThis.clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  /**
   * Permanently closes and removes every resumable connection and channel handle.
   * @param {string} reason - Reason reported to each handle.
   * @returns {void}
   */
  _closeSessionHandles(reason) {
    const connections = [...this._connections.values()]
    const channelSubscriptions = [...this._channelSubscriptions.values()]
    let firstCallbackError
    let callbackFailed = false

    this._connections.clear()
    this._channelSubscriptions.clear()
    this._sessionId = null
    this._awaitingResume = false
    this._pendingSessionId = null

    for (const connection of connections) {
      try {
        connection._handleClosed(reason)
      } catch (error) {
        if (!callbackFailed) firstCallbackError = error
        callbackFailed = true
      }
    }

    for (const subscription of channelSubscriptions) {
      try {
        subscription._handleClosed(reason)
      } catch (error) {
        if (!callbackFailed) firstCallbackError = error
        callbackFailed = true
      }
    }

    if (callbackFailed) throw firstCallbackError
  }

  /**
   * Processes one socket's terminal lifecycle exactly once.
   * @param {WebSocket} socket - Socket that closed or is being torn down.
   * @param {unknown} [error] - Failure propagated to pending operations.
   * @param {boolean} [allowReconnect] - Whether this close may schedule reconnect.
   * @returns {void}
   */
  _handleSocketClose(socket, error, allowReconnect = this.autoReconnect) {
    if (this._closedSockets.has(socket)) return
    this._closedSockets.add(socket)

    const handleCloseReason = this._clientClosingSockets.has(socket) ? "client_close" : "session_destroyed"

    this._clientClosingSockets.delete(socket)

    this._stopSocketKeepalive()
    this.disconnectedSince ||= Date.now()
    this._resetSessionReadyState(error)

    for (const [id, {reject}] of this.pendingRequests.entries()) {
      reject(error || new Error(`Websocket closed before response for ${id}`))
    }

    for (const [subscriptionKey, {reject}] of this.pendingSubscriptions.entries()) {
      reject(error || new Error("Websocket closed before subscription acknowledgement"))
      this.listeners.delete(subscriptionKey)
    }

    this.pendingRequests.clear()
    this.pendingSubscriptions.clear()
    this.connectPromise = undefined
    if (this.socket === socket && socket.readyState === socket.CLOSED) this.socket = undefined

    if (this._sessionId && this.autoReconnect) {
      // Session may resume when we reconnect — keep the handles alive and fire
      // onDisconnect so user code can pause UI work.
      for (const connection of this._connections.values()) connection._handleDisconnected()
      for (const subscription of this._channelSubscriptions.values()) subscription._handleDisconnected()
    } else {
      // No resume path: tear down every live connection / channel sub.
      this._closeSessionHandles(handleCloseReason)
    }

    if (!allowReconnect || !this.autoReconnect) return

    void this._shouldWaitForOnline().then((shouldWaitForOnline) => {
      if (!shouldWaitForOnline) {
        this._scheduleReconnect()
      }
    })
  }

  onClose = (event) => {
    const socket = event.currentTarget || this.socket

    if (socket) this._handleSocketClose(socket)
  }

  /**
   * @param {Record<string, any>} payload - Payload data.
   * @returns {void}
   */
  _sendMessage(payload) {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("Websocket is not open")
    }

    const json = JSON.stringify(payload)

    this._debug("Sending", json)
    this.socket.send(json)
  }

  /** @returns {void} */
  _cancelPendingReconnect() {
    if (this.reconnectTimer) {
      globalThis.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** @returns {void} */
  _scheduleReconnect() {
    this._cancelPendingReconnect()

    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)]

    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null
      void this._attemptReconnect()
    }, delay)

    this.reconnectAttempt += 1
  }

  /** @returns {Promise<void>} */
  async _attemptReconnect() {
    if (!this.autoReconnect) return

    if (!await this._isOnline()) {
      this._waitingForOnline = true
      return
    }

    try {
      this._waitingForOnline = false
      this.connectionAttempts += 1
      await this.connect({autoReconnect: this.autoReconnect, resetReconnectState: false, waitForOnline: false})
      this.reconnectAttempt = 0
      this.disconnectedSince = null
      this._resubscribeActiveListeners()

      if (typeof this.onReconnect === "function") {
        await this.onReconnect()
      }
    } catch (error) {
      this._debug("Reconnect attempt failed:", error)

      if (this.autoReconnect) {
        this._scheduleReconnect()
      }
    }
  }

  /**
   * Re-sends subscribe messages for all active listeners after reconnection.
   * @returns {void}
   */
  _resubscribeActiveListeners() {
    for (const [, listenerEntry] of this.listeners) {
      try {
        this._sendMessage({
          channel: listenerEntry.channel,
          params: listenerEntry.params,
          type: "subscribe"
        })
      } catch (error) {
        this._debug("Re-subscribe failed:", error)
      }
    }
  }

  /**
   * @param  {...any} args - Log arguments.
   * @returns {void}
   */
  _debug(...args) {
    if (!this.debug) return

    console.debug("[SnapReqWebSocketClient]", ...args)
  }

  /**
   * @param {string} sessionId - Id to persist through the configured sessionStore.
   * @returns {void}
   */
  _persistSessionId(sessionId) {
    if (!this._sessionStore) return

    try {
      const result = this._sessionStore.set(sessionId)

      if (result && typeof result.then === "function") {
        result.catch((/** @type {unknown} */ error) => this._debug("sessionStore.set failed", error))
      }
    } catch (error) {
      this._debug("sessionStore.set failed", error)
    }
  }

  /** @returns {void} */
  _clearPersistedSessionId() {
    if (!this._sessionStore) return

    try {
      const result = this._sessionStore.clear()

      if (result && typeof result.then === "function") {
        result.catch((/** @type {unknown} */ error) => this._debug("sessionStore.clear failed", error))
      }
    } catch (error) {
      this._debug("sessionStore.clear failed", error)
    }
  }

  /** @returns {Promise<void>} - Resolves once the session is ready. */
  _waitForSessionReady() {
    if (this._sessionReady) return Promise.resolve()

    if (!this._sessionReadyPromise || !this._resolveSessionReady) {
      this._sessionReadyPromise = new Promise((resolve) => {
        this._resolveSessionReady = resolve
      })
    }

    return this._sessionReadyPromise.then(() => {
      if (this._sessionReadyError) {
        const error = this._sessionReadyError

        this._sessionReadyError = null
        throw error
      }
    })
  }

  /** @returns {void} */
  _markSessionReady() {
    if (this._sessionReady) return

    this._sessionReady = true
    this._sessionReadyError = null
    this._resolveSessionReady?.()
    this._resolveSessionReady = null
    this._sessionReadyPromise = null
  }

  /**
   * @param {unknown} [error] - Reason for the reset.
   * @returns {void}
   */
  _resetSessionReadyState(error = new Error("Websocket session readiness was reset")) {
    this._sessionReady = false
    this._pendingSessionId = null
    this._sessionReadyError = error
    this._resolveSessionReady?.()
    this._sessionReadyPromise = null
    this._resolveSessionReady = null
  }
}

/** A response to a request made over the WebSocket transport. */
export class SnapReqWebSocketResponse {
  /**
   * @param {object} message - The response message.
   * @param {(value: any) => any} [deserialize] - Transform applied to the parsed body in `json()`. Defaults to identity.
   */
  constructor(message, deserialize) {
    const responseMessage = /** @type {{body?: any, headers?: Record<string, any>, id?: string | number | null, statusCode?: number, statusMessage?: string, type?: string}} */ (message)

    this.body = responseMessage.body
    this.headers = responseMessage.headers || {}
    this.id = responseMessage.id
    this.statusCode = responseMessage.statusCode || 200
    this.statusMessage = responseMessage.statusMessage || "OK"
    this.type = responseMessage.type
    this._deserialize = deserialize || ((value) => value)
  }

  /** @returns {any} - The parsed (and optionally deserialized) JSON body. */
  json() {
    if (typeof this.body !== "string") {
      throw new Error("Response body is not a string")
    }

    return this._deserialize(JSON.parse(this.body))
  }
}
