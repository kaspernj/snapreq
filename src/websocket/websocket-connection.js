// @ts-check

/**
 * Client-side handle for a 1:1 connection opened via
 * `SnapReqWebSocketClient.openConnection()`. Mirrors the server's connection
 * lifecycle — `onConnect` / `onMessage` / `onClose` plus `sendMessage` /
 * `close`.
 */
export default class SnapReqWebSocketConnection {
  /**
   * @param {object} args - Connection arguments.
   * @param {import("./websocket-client.js").default} args.client - Owning client.
   * @param {string} args.connectionId - Generated id unique within the session.
   * @param {string} args.connectionType - Name the server registered the class under.
   * @param {Record<string, any>} [args.params] - Opaque params forwarded to the server.
   * @param {() => void} [args.onConnect] - Fired after the server confirms `connection-opened`.
   * @param {(body: any) => void} [args.onMessage] - Fired on each `connection-message` from the server.
   * @param {() => void} [args.onDisconnect] - Fired when the socket drops; connection is preserved pending resume.
   * @param {() => void} [args.onResume] - Fired when the session successfully resumes after a drop.
   * @param {(reason: string) => void} [args.onClose] - Fired exactly once when the handle closes permanently.
   */
  constructor({client, connectionId, connectionType, params, onConnect, onMessage, onDisconnect, onResume, onClose}) {
    this.client = client
    this.connectionId = connectionId
    this.connectionType = connectionType
    this.params = params || {}
    this._onConnect = onConnect
    this._onMessage = onMessage
    this._onDisconnect = onDisconnect
    this._onResume = onResume
    this._onClose = onClose
    this._connected = false
    this._closed = false

    /** @type {Promise<void>} - Resolves once the server sends `connection-opened`. */
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
  }

  /**
   * Called by the client dispatcher when `{type: "connection-opened"}` arrives.
   * Fires the user's `onConnect` and resolves `ready`.
   * @returns {void}
   */
  _handleOpened() {
    if (this._closed || this._connected) return
    this._connected = true

    try {
      this._onConnect?.()
    } finally {
      this._resolveReady?.()
    }
  }

  /**
   * Called by the client dispatcher for each `connection-message` targeted at
   * this connection id.
   * @param {any} body - Message payload.
   * @returns {void}
   */
  _handleMessage(body) {
    if (this._closed) return
    this._onMessage?.(body)
  }

  /**
   * Called by the client when the underlying socket drops. The connection stays
   * alive pending session resume.
   * @returns {void}
   */
  _handleDisconnected() {
    if (this._closed) return
    this._onDisconnect?.()
  }

  /**
   * Called by the client after `session-resumed` confirms the server still has
   * this connection.
   * @returns {void}
   */
  _handleResumed() {
    if (this._closed) return
    this._onResume?.()
  }

  /**
   * Called by the client dispatcher when the connection closes for any reason.
   * Fires `onClose(reason)` at most once.
   * @param {string} reason - Why the connection closed.
   * @returns {void}
   */
  _handleClosed(reason) {
    if (this._closed) return
    this._closed = true

    try {
      this._onClose?.(reason)
    } finally {
      if (!this._connected) {
        this._rejectReady?.(new Error(`Connection closed before open: ${reason}`))
      }
    }
  }

  /**
   * Sends a message to the server side of this connection.
   * @param {any} body - Message payload.
   * @returns {void}
   */
  sendMessage(body) {
    if (this._closed) {
      throw new Error(`Cannot sendMessage on closed connection ${this.connectionId}`)
    }

    this.client._sendMessage({
      type: "connection-message",
      connectionId: this.connectionId,
      body
    })
  }

  /**
   * Closes the connection from the client side. Fires `onClose("client_close")`
   * locally and notifies the server. No-op if already closed.
   * @returns {void}
   */
  close() {
    if (this._closed) return

    // Send the close frame BEFORE flipping _closed so _sendMessage doesn't
    // refuse — and guard against a socket that's already gone so the local
    // teardown still runs.
    try {
      if (this.client.isOpen()) {
        this.client._sendMessage({type: "connection-close", connectionId: this.connectionId})
      }
    } catch {
      // Socket may have closed between our check and the send; the server will
      // see the session destroy and clean up regardless.
    }

    this.client._removeConnection(this.connectionId)
    this._handleClosed("client_close")
  }

  /** @returns {boolean} - Whether the connection is closed. */
  isClosed() { return this._closed }

  /** @returns {boolean} - Whether the connection is open. */
  isConnected() { return this._connected && !this._closed }
}
