// @ts-check

import SnapReqHeaders from "./headers.js"

/**
 * @typedef {"identity" | "gzip" | "deflate" | "br" | "zstd"} CompressionEncoding
 */

/**
 * @typedef {object} NormalizedBody
 * @property {"none" | "text" | "bytes" | "stream"} kind - Shape of the body payload.
 * @property {string | Uint8Array | AsyncIterable<Uint8Array> | null} value - The payload itself.
 */

const ABSOLUTE_URL_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Joins a base URL and a path and appends query parameters. `path` may be a
 * fully-qualified URL, in which case the base is ignored.
 * @param {string | undefined} baseUrl - Origin (and optional base path).
 * @param {string} path - Path or absolute URL.
 * @param {Record<string, string | number | boolean | null | undefined> | undefined} query - Query parameters.
 * @returns {string} - Resolved absolute URL.
 */
export function buildUrl(baseUrl, path, query) {
  /** @type {string} */
  let resolved

  if (ABSOLUTE_URL_REGEX.test(path)) {
    resolved = path
  } else if (baseUrl) {
    resolved = `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
  } else {
    resolved = path
  }

  if (!query) return resolved

  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.append(key, String(value))
  }

  const queryString = params.toString()

  if (!queryString) return resolved

  return resolved.includes("?") ? `${resolved}&${queryString}` : `${resolved}?${queryString}`
}

/**
 * Determines whether a value should be sent as a streamed request body.
 * @param {unknown} body - Candidate body value.
 * @returns {boolean} - Whether the body is a stream.
 */
export function isStreamBody(body) {
  return Boolean(
    body &&
    typeof body === "object" &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer) &&
    (typeof (/** @type {any} */ (body).pipe) === "function" || typeof (/** @type {any} */ (body)[Symbol.asyncIterator]) === "function")
  )
}

/**
 * Normalizes a user-supplied body into one of a small set of shapes and applies
 * a default `Content-Type` header when the caller did not set one.
 * @param {unknown} body - Raw body value.
 * @param {SnapReqHeaders} headers - Headers to receive a default `Content-Type`.
 * @returns {NormalizedBody} - Normalized body descriptor.
 */
export function normalizeBody(body, headers) {
  if (body === undefined || body === null) {
    return {kind: "none", value: null}
  }

  if (body instanceof Uint8Array) {
    if (!headers.has("content-type")) headers.set("Content-Type", "application/octet-stream")

    return {kind: "bytes", value: body}
  }

  if (body instanceof ArrayBuffer) {
    if (!headers.has("content-type")) headers.set("Content-Type", "application/octet-stream")

    return {kind: "bytes", value: new Uint8Array(body)}
  }

  if (isStreamBody(body)) {
    if (!headers.has("content-type")) headers.set("Content-Type", "application/octet-stream")

    return {kind: "stream", value: /** @type {AsyncIterable<Uint8Array>} */ (body)}
  }

  if (typeof body === "string") {
    return {kind: "text", value: body}
  }

  if (!headers.has("content-type")) headers.set("Content-Type", "application/json")

  return {kind: "text", value: JSON.stringify(body)}
}
