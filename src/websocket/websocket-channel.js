// @ts-check

import {runControlled} from "../control.js"

/**
 * Client-side handle for a channel subscription opened via
 * `SnapReqWebSocketClient.subscribeChannel()`. Mirrors the server's
 * subscription lifecycle — `subscribed` (resolves `ready`) / `onMessage` /
 * `onClose`.
 */
export default class SnapReqWebSocketChannel {
  /**
   * @param {object} args - Channel arguments.
   * @param {import("./websocket-client.js").default} args.client - Owning client.
   * @param {string} args.subscriptionId - Generated id unique within the session.
   * @param {string} args.channelType - Name the server registered the channel under.
   * @param {Record<string, any>} [args.params] - Opaque params forwarded to the server.
   * @param {string} [args.lastEventId] - Resume replay from this event id.
   * @param {number} [args.timeoutMs] - Server-confirmed readiness deadline.
   * @param {AbortSignal} [args.signal] - Cancels readiness without affecting other subscriptions.
   * @param {(body: any) => void} [args.onMessage] - Fired on each `channel-message` from the server.
   * @param {() => void} [args.onDisconnect] - Fired when the socket drops.
   * @param {() => void} [args.onResume] - Fired when the session resumes after a drop.
   * @param {(reason: string) => void} [args.onClose] - Fired exactly once when the subscription closes permanently.
   */
  constructor({client, subscriptionId, channelType, params, lastEventId, timeoutMs, signal, onMessage, onDisconnect, onResume, onClose}) {
    this.client = client
    this.subscriptionId = subscriptionId
    this.channelType = channelType
    this.params = params || {}
    this.lastEventId = lastEventId
    this._onMessage = onMessage
    this._onDisconnect = onDisconnect
    this._onResume = onResume
    this._onClose = onClose
    this._ready = false
    this._resumeReadyOnResume = false
    this._subscribed = false
    this._subscribeSent = false
    this._closed = false
    this._readyControls = {timeoutMs, signal}
    /** @type {Promise<void> | null} */
    this._controlledReadyPromise = null
  }

  /** @returns {Promise<void>} - Resolves once the subscription is acknowledged. */
  _ensureReadyPromise() {
    if (!this._readyPromise || !this._resolveReady || !this._rejectReady) {
      /** @type {Promise<void>} */
      this._readyPromise = new Promise((resolve, reject) => {
        this._resolveReady = resolve
        this._rejectReady = reject
      })
    }

    return this._readyPromise
  }

  /** @returns {Promise<void>} - Resolves once the subscription is acknowledged. */
  get ready() {
    if (!this._controlledReadyPromise) {
      this._controlledReadyPromise = runControlled(this._readyControls, () => this._ensureReadyPromise()).catch((error) => {
        if (!this._closed) this.close()

        throw error
      })
    }

    return this._controlledReadyPromise
  }

  /** @returns {void} */
  _resolveReadyState() {
    this._ready = true
    this._resolveReady?.()
    this._resolveReady = null
    this._rejectReady = null
  }

  /** @returns {void} */
  _markNotReady() {
    this._ready = false
  }

  /** @returns {void} */
  _handleSubscribed() {
    if (this._closed || this._subscribed) return
    this._subscribed = true
    this._resolveReadyState()
  }

  /** @returns {void} */
  _markSubscribeSent() {
    this._subscribeSent = true
  }

  /** @returns {boolean} - Whether the subscription still needs to be sent. */
  _needsSubscribe() {
    return !this._closed && !this._subscribeSent
  }

  /**
   * @param {any} body - Message payload.
   * @returns {void}
   */
  _handleMessage(body) {
    if (this._closed) return
    this._onMessage?.(body)
  }

  /** @returns {void} */
  _handleDisconnected() {
    if (this._closed) return
    this._resumeReadyOnResume ||= this._subscribed
    this._subscribed = false
    this._markNotReady()
    this._onDisconnect?.()
  }

  /** @returns {void} */
  _handleResumed() {
    if (this._closed) return
    if (this._resumeReadyOnResume) {
      this._subscribed = true
      this._resolveReadyState()
    }
    this._resumeReadyOnResume = false
    this._onResume?.()
  }

  /** @returns {void} */
  _handleSessionGone() {
    if (this._closed) return

    this._subscribed = false
    this._subscribeSent = false
    this._resumeReadyOnResume = false
    this._markNotReady()
  }

  /**
   * @param {string} reason - Why the subscription closed.
   * @returns {void}
   */
  _handleClosed(reason) {
    if (this._closed) return
    this._closed = true

    try {
      this._onClose?.(reason)
    } finally {
      this._resumeReadyOnResume = false
      if (!this._ready) {
        if (reason === "client_unsubscribe") {
          // The client itself closed the subscription before the server ack
          // (e.g. a UI component unmounting right after subscribing). That is a
          // benign race, not a failure — resolve `ready` so awaiting callers
          // don't surface a spurious "closed before acknowledgement" error.
          this._resolveReady?.()
        } else {
          this._rejectReady?.(new Error(`Subscription closed before acknowledgement: ${reason}`))
        }
      }

      this._resolveReady = null
      this._rejectReady = null
    }
  }

  /**
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [params] - Operation controls, overriding constructor controls.
   * @returns {Promise<void>} - Resolves once ready or rejects on timeout/cancellation.
   */
  async waitForReady({timeoutMs = 5000, signal} = {}) {
    if (this._ready) return

    try {
      await runControlled({timeoutMs, signal}, () => this._ensureReadyPromise())
    } catch (error) {
      if (!this._closed) this.close()
      throw error
    }
  }

  /** @returns {void} */
  close() {
    if (this._closed) return

    try {
      if (this.client.isOpen()) {
        this.client._sendMessage({type: "channel-unsubscribe", subscriptionId: this.subscriptionId})
      }
    } catch {
      // Socket already gone; server will clean up on session teardown.
    }

    this.client._removeChannelSubscription(this.subscriptionId)
    this._handleClosed("client_unsubscribe")
  }

  /** @returns {boolean} - Whether the subscription is closed. */
  isClosed() { return this._closed }

  /** @returns {boolean} - Whether the subscription is acknowledged and ready. */
  isReady() { return this._ready }

  /** @returns {boolean} - Whether the subscription is active. */
  isSubscribed() { return this._subscribed && !this._closed }
}
