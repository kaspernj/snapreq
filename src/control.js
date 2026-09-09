// @ts-check

import timeout from "awaitery/build/timeout.js"
import {SnapReqAbortError, SnapReqIdleTimeoutError, SnapReqTimeoutError} from "./errors.js"

/** @typedef {"connect_or_headers" | "request_body" | "response_body"} HttpRequestProgressPhase */

/**
 * Owns one HTTP attempt's absolute deadline, inactivity watchdog, caller
 * cancellation, first causal error, and terminal cleanup.
 */
export class HttpRequestControl {
  /**
   * @param {object} options - HTTP request controls.
   * @param {string} options.method - HTTP method.
   * @param {string} options.url - Fully resolved request URL.
   * @param {number} [options.timeoutMs] - Absolute request/body deadline.
   * @param {number} [options.idleTimeoutMs] - Progress-resetting inactivity timeout.
   * @param {AbortSignal} [options.signal] - Caller cancellation signal.
   * @param {(callback: () => void, milliseconds: number) => any} [options.setTimeoutImplementation] - Injectable scheduler for deterministic tests.
   * @param {(timer: any) => void} [options.clearTimeoutImplementation] - Injectable scheduler cleanup for deterministic tests.
   */
  constructor({method, url, timeoutMs, idleTimeoutMs, signal, setTimeoutImplementation = globalThis.setTimeout, clearTimeoutImplementation = globalThis.clearTimeout}) {
    this.method = method
    this.url = url
    this.timeoutMs = timeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    /** @type {HttpRequestProgressPhase} */
    this.phase = "connect_or_headers"
    this._setTimeout = setTimeoutImplementation
    this._clearTimeout = clearTimeoutImplementation
    this._callerSignal = signal
    this._controller = new AbortController()
    this.signal = this._controller.signal
    /** @type {SnapReqAbortError | SnapReqTimeoutError | SnapReqIdleTimeoutError | null} */
    this.error = null
    /** @type {any} */
    this._totalTimer = null
    /** @type {any} */
    this._idleTimer = null
    /** @type {((error: SnapReqAbortError | SnapReqTimeoutError | SnapReqIdleTimeoutError) => void) | null} */
    this._cancelBody = null
    this._active = true
    this._onCallerAbort = () => this._cancel(new SnapReqAbortError())

    if (signal?.aborted) {
      this._cancel(new SnapReqAbortError())
      return
    }

    signal?.addEventListener("abort", this._onCallerAbort, {once: true})
    this._scheduleTotalTimeout()
    this._scheduleIdleTimeout()
  }

  /**
   * Resets the inactivity watchdog after transport progress.
   * @param {HttpRequestProgressPhase} phase - Phase that made progress.
   * @returns {void}
   */
  progress(phase) {
    if (!this._active) return

    this.phase = phase
    this._scheduleIdleTimeout()
  }

  /**
   * Waits for response readiness while guaranteeing that control cancellation
   * settles even when a custom transport does not observe the abort signal.
   * @template T
   * @param {() => T | Promise<T>} callback - Transport operation.
   * @returns {Promise<T>} - Transport result.
   */
  async run(callback) {
    if (this.error) throw this.error

    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(this.error)

      this.signal.addEventListener("abort", onAbort, {once: true})
      Promise.resolve()
        .then(callback)
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener("abort", onAbort))
    })
  }

  /**
   * Attaches cancellation of a response body after headers have arrived.
   * @param {(error: SnapReqAbortError | SnapReqTimeoutError | SnapReqIdleTimeoutError) => void} cancelBody - Response-body cancellation callback.
   * @returns {void}
   */
  setBodyCancellation(cancelBody) {
    if (this.error) {
      cancelBody(this.error)
      return
    }

    if (this._active) this._cancelBody = cancelBody
  }

  /** Clears every timer/listener after success or a non-control error. */
  finish() {
    if (!this._active) return

    this._active = false
    this._cleanup()
  }

  /** @returns {void} */
  _scheduleTotalTimeout() {
    if (!this._active || !this.timeoutMs || this.timeoutMs <= 0) return

    const timer = this._setTimeout(() => {
      if (this._totalTimer !== timer) return

      this._cancel(new SnapReqTimeoutError({method: this.method, url: this.url, timeoutMs: this.timeoutMs}))
    }, this.timeoutMs)

    this._totalTimer = timer
  }

  /** @returns {void} */
  _scheduleIdleTimeout() {
    if (!this._active || !this.idleTimeoutMs || this.idleTimeoutMs <= 0) return

    this._clearIdleTimer()

    const timer = this._setTimeout(() => {
      if (this._idleTimer !== timer) return

      this._cancel(new SnapReqIdleTimeoutError({
        idleTimeoutMs: this.idleTimeoutMs,
        method: this.method,
        phase: this.phase,
        url: this.url
      }))
    }, this.idleTimeoutMs)

    this._idleTimer = timer
  }

  /**
   * @param {SnapReqAbortError | SnapReqTimeoutError | SnapReqIdleTimeoutError} error - First causal control error.
   * @returns {void}
   */
  _cancel(error) {
    if (!this._active) return

    const cancelBody = this._cancelBody

    this.error = error
    this._active = false
    this._cleanup()
    try {
      cancelBody?.(error)
    } finally {
      this._controller.abort(error)
    }
  }

  /** @returns {void} */
  _cleanup() {
    this._clearTotalTimer()
    this._clearIdleTimer()
    this._callerSignal?.removeEventListener("abort", this._onCallerAbort)
    this._cancelBody = null
  }

  /** @returns {void} */
  _clearTotalTimer() {
    if (this._totalTimer === null) return

    this._clearTimeout(this._totalTimer)
    this._totalTimer = null
  }

  /** @returns {void} */
  _clearIdleTimer() {
    if (this._idleTimer === null) return

    this._clearTimeout(this._idleTimer)
    this._idleTimer = null
  }
}

/**
 * Runs asynchronous work with optional cooperative deadline/cancellation.
 * @template T
 * @param {{timeoutMs?: number, signal?: AbortSignal}} options - Operation controls.
 * @param {(signal: AbortSignal | undefined) => T | Promise<T>} callback - Controlled work.
 * @returns {Promise<T>} - Callback result.
 */
export async function runControlled({timeoutMs, signal}, callback) {
  if (timeoutMs !== undefined && timeoutMs > 0) {
    return await timeout({timeout: timeoutMs, signal}, ({control}) => callback(control.signal))
  }

  if (signal) {
    signal.throwIfAborted()

    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, {once: true})

      Promise.resolve()
        .then(() => callback(signal))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort))
    })
  }

  return await callback(undefined)
}
