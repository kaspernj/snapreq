// @ts-check

import SnapReqWebSocketConnection from "./websocket-connection.js"
import SnapReqWebSocketChannel from "./websocket-channel.js"

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
   */
  constructor({autoReconnect = true, debug = false, networkMonitor, reconnectDelays, sessionStore, url} = /** @type {any} */ ({})) {
    if (!globalThis.WebSocket) throw new Error("WebSocket global is not available")
    if (!url) throw new Error("SnapReqWebSocketClient requires a url")

    /** @type {boolean} */
    this.autoReconnect = autoReconnect
    this.debug = debug
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
   * @param {{params?: Record<string, any>, onConnect?: () => void, onMessage?: (body: any) => void, onDisconnect?: () => void, onResume?: () => void, onClose?: (reason: string) => void}} [options] - Connection options.
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
      onConnect: options.onConnect,
      onMessage: options.onMessage,
      onDisconnect: options.onDisconnect,
      onResume: options.onResume,
      onClose: options.onClose
    })

    this._connections.set(connectionId, connection)
    this._sendMessage({
      type: "connection-open",
      connectionId,
      connectionType,
      params: options.params || {}
    })

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
   * Subscribes to a named channel. If the socket is not yet open, the
   * subscription is queued and sent once a connection is established.
   * @param {string} channelType - Name the server registered the channel under.
   * @param {{params?: Record<string, any>, lastEventId?: string, onMessage?: (body: any) => void, onDisconnect?: () => void, onResume?: () => void, onClose?: (reason: string) => void}} [options] - Subscription options.
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
   * @param {{autoReconnect?: boolean, waitForOnline?: boolean, resetReconnectState?: boolean}} [options] - Connect options.
   * @returns {Promise<void>} - Resolves once connected and the session is ready.
   */
  async connect({autoReconnect = this.autoReconnect, waitForOnline = true, resetReconnectState = true} = {}) {
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

    if (this.socket && this.socket.readyState === this.socket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this._resetSessionReadyState()
    this._waitingForOnline = false
    this.connectionAttempts += 1

    this.connectPromise = new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url)

      const cleanup = () => {
        this.socket?.removeEventListener("open", onOpen)
        this.socket?.removeEventListener("error", onError)
      }

      const onOpen = () => {
        cleanup()
        resolve(undefined)
      }
      const onError = (/** @type {Event & {error?: unknown}} */ event) => {
        cleanup()
        const error = event?.error || new Error("Websocket connection error")
        reject(error)
      }

      this.socket.addEventListener("open", onOpen)
      this.socket.addEventListener("error", onError)
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
   * Closes the WebSocket and clears pending state.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async close() {
    this.autoReconnect = false
    this._waitingForOnline = false
    this._cancelPendingReconnect()
    this._teardownNetworkMonitorSubscription()

    if (!this.socket) return

    if (this.socket.readyState === this.socket.CLOSED) {
      this.socket = undefined
      this.connectPromise = undefined
      this._resetSessionReadyState()
      return
    }

    await new Promise((resolve) => {
      this.socket?.addEventListener("close", () => resolve(undefined))
      this.socket?.close()
    })

    this.socket = undefined
    this.connectPromise = undefined
    this._resetSessionReadyState()
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
   * @param {{headers?: Record<string, string>}} [options] - Request options such as headers.
   * @returns {Promise<SnapReqWebSocketResponse>} - The response.
   */
  async post(path, body, options = {}) {
    return await this.request("POST", path, {...options, body})
  }

  /**
   * Performs a GET request over the WebSocket.
   * @param {string} path - Path.
   * @param {{headers?: Record<string, string>}} [options] - Request options such as headers.
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
   * @param {{lastEventId?: string, params?: Record<string, any>}} options - Subscription options.
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
      }
    }

    unsubscribe.ready = listenerEntry.ready

    return unsubscribe
  }

  /**
   * Subscribes to a channel and waits until the server acknowledges it.
   * @param {string} channel - Channel name.
   * @param {{lastEventId?: string, params?: Record<string, any>}} options - Subscription options.
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
   * @returns {Promise<SnapReqWebSocketResponse>} - The response.
   */
  async request(method, path, {body, headers} = {}) {
    await this.connect()

    const id = `ws-${this.nextID++}`
    const payload = {
      body,
      headers,
      id,
      method,
      path,
      type: "request"
    }

    return await new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {resolve, reject})
      this._sendMessage(payload)
    })
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
        pending.resolve(new SnapReqWebSocketResponse(message))
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
        this._sendPendingChannelSubscriptions()
      }
    } else if (type === "session-resumed") {
      this._awaitingResume = false
      this._pendingSessionId = null
      this._sessionId = message.sessionId
      this._persistSessionId(message.sessionId)
      this._markSessionReady()
      this._sendPendingChannelSubscriptions()
      // Fire onResume on every live handle so user code knows the session came
      // back with state intact.
      for (const connection of this._connections.values()) connection._handleResumed()
      for (const subscription of this._channelSubscriptions.values()) subscription._handleResumed()
    } else if (type === "session-gone") {
      this._awaitingResume = false
      this._sessionId = null
      this._pendingSessionId = null
      this._clearPersistedSessionId()

      // Tear down every live handle — their server-side counterparts are gone.
      const connections = [...this._connections.values()]

      this._connections.clear()
      for (const connection of connections) connection._handleClosed("session_gone")

      const subs = [...this._channelSubscriptions.values()]

      this._channelSubscriptions.clear()
      for (const subscription of subs) subscription._handleClosed("session_gone")

      this._markSessionReady()
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
  onClose = () => {
    this.disconnectedSince ||= Date.now()
    this._resetSessionReadyState()

    for (const [id, {reject}] of this.pendingRequests.entries()) {
      reject(new Error(`Websocket closed before response for ${id}`))
    }

    for (const {reject} of this.pendingSubscriptions.values()) {
      reject(new Error("Websocket closed before subscription acknowledgement"))
    }

    if (this._sessionId && this.autoReconnect) {
      // Session may resume when we reconnect — keep the handles alive and fire
      // onDisconnect so user code can pause UI work.
      for (const connection of this._connections.values()) connection._handleDisconnected()
      for (const subscription of this._channelSubscriptions.values()) subscription._handleDisconnected()
    } else {
      // No resume path: tear down every live connection / channel sub.
      const connections = [...this._connections.values()]

      this._connections.clear()
      for (const connection of connections) {
        connection._handleClosed("session_destroyed")
      }

      const channelSubs = [...this._channelSubscriptions.values()]

      this._channelSubscriptions.clear()
      for (const subscription of channelSubs) {
        subscription._handleClosed("session_destroyed")
      }

      this._sessionId = null
    }

    this.pendingRequests.clear()
    this.pendingSubscriptions.clear()
    this.connectPromise = undefined

    if (!this.autoReconnect) return

    void this._shouldWaitForOnline().then((shouldWaitForOnline) => {
      if (!shouldWaitForOnline) {
        this._scheduleReconnect()
      }
    })
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
   */
  constructor(message) {
    const responseMessage = /** @type {{body?: any, headers?: Record<string, any>, id?: string | number | null, statusCode?: number, statusMessage?: string, type?: string}} */ (message)

    this.body = responseMessage.body
    this.headers = responseMessage.headers || {}
    this.id = responseMessage.id
    this.statusCode = responseMessage.statusCode || 200
    this.statusMessage = responseMessage.statusMessage || "OK"
    this.type = responseMessage.type
  }

  /** @returns {any} - The parsed JSON body. */
  json() {
    if (typeof this.body !== "string") {
      throw new Error("Response body is not a string")
    }

    return JSON.parse(this.body)
  }
}
