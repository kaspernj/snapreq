// @ts-check

import {SnapReqTimeoutError} from "./errors.js"
import retry from "awaitery/build/retry.js"

const RETRYABLE_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOENT", "ETIMEDOUT", "EPIPE"])
const DEFAULT_RETRYABLE_STATUSES = [502, 503, 504]

/**
 * @typedef {object} RetryOptions
 * @property {number} [tries] - Maximum number of attempts. Defaults to 3.
 * @property {number} [waitMs] - Delay between attempts in milliseconds. Defaults to 500.
 * @property {number[]} [retryableStatuses] - HTTP status codes that should be retried. Defaults to 502/503/504.
 * @property {(error: unknown, attempt: number) => boolean} [shouldRetry] - Override the retryable-error classifier.
 */

/**
 * @typedef {object} NormalizedRetryOptions
 * @property {number} tries - Maximum number of attempts.
 * @property {number} waitMs - Delay between attempts in milliseconds.
 * @property {number[]} retryableStatuses - HTTP status codes that should be retried.
 * @property {(error: unknown, attempt: number) => boolean} shouldRetry - Retryable-error classifier.
 */

/**
 * The default network-error classifier. Exposed so callers can compose extra
 * rules on top of it (for example matching server-specific 500 messages).
 * @param {unknown} error - Error thrown by a transport.
 * @returns {boolean} - Whether the error is a transient network failure.
 */
export function defaultRetryableError(error) {
  if (error instanceof SnapReqTimeoutError) return true

  if (!error || typeof error !== "object") return false

  if ("code" in error && typeof error.code === "string" && RETRYABLE_ERROR_CODES.has(error.code)) {
    return true
  }

  return error instanceof Error && error.message === "socket hang up"
}

/**
 * Normalizes the `retry` option into a complete set of retry settings, or
 * `null` when retries are disabled.
 * @param {boolean | RetryOptions | undefined} retry - Retry configuration.
 * @returns {NormalizedRetryOptions | null} - Normalized retry settings.
 */
export function normalizeRetryOptions(retry) {
  if (!retry) return null

  const options = retry === true ? {} : retry
  const retryableStatuses = options.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES
  const shouldRetry = options.shouldRetry ?? ((/** @type {unknown} */ error) => defaultRetryableError(error))

  return {
    tries: options.tries ?? 3,
    waitMs: options.waitMs ?? 500,
    retryableStatuses,
    shouldRetry
  }
}

class RetryableResponse extends Error {
  /** @param {import("./response.js").default} response - Retryable response. */
  constructor(response) {
    super(`Retryable HTTP status ${response.status}`)
    this.response = response
  }
}

/**
 * Runs a request attempt, retrying transient network errors and retryable HTTP
 * statuses. Retries are only used for buffered requests — the caller must not
 * apply this to streamed responses.
 * @param {(signal: AbortSignal | undefined) => Promise<import("./response.js").default>} attempt - Performs one request attempt.
 * @param {NormalizedRetryOptions} retryOptions - Normalized retry settings.
 * @param {AbortSignal} [signal] - Caller cancellation signal.
 * @returns {Promise<import("./response.js").default>} - The successful (or final) response.
 */
export async function runWithRetry(attempt, retryOptions, signal) {
  try {
    return await retry({
      tries: retryOptions.tries,
      wait: retryOptions.waitMs,
      signal,
      shouldRetry: ({error, tryNumber}) => {
        if (error instanceof RetryableResponse) {
          // Awaitery calls shouldRetry only when another attempt is available,
          // and before its retry delay. The final response therefore remains
          // caller-owned while every intermediate body is released promptly.
          error.response._abortBody(error)
          return true
        }

        return retryOptions.shouldRetry(error, tryNumber)
      }
    }, async ({signal: attemptSignal} = /** @type {any} */ ({})) => {
      const response = await attempt(attemptSignal)

      if (retryOptions.retryableStatuses.includes(response.status)) {
        throw new RetryableResponse(response)
      }

      return response
    })
  } catch (error) {
    if (error instanceof RetryableResponse) return error.response

    throw error
  }
}
