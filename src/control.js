// @ts-check

import timeout from "awaitery/build/timeout.js"

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
