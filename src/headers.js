// @ts-check

/**
 * A tiny case-insensitive header bag. Works the same on every platform and
 * avoids depending on the DOM `Headers` global (absent in some runtimes) or on
 * Node's header handling. Header values are always stored as strings.
 */
export default class SnapReqHeaders {
  /**
   * @param {Record<string, string | number | string[]> | SnapReqHeaders | Iterable<[string, string]>} [init] - Initial headers.
   */
  constructor(init) {
    /** @type {Map<string, {name: string, value: string}>} - Keyed by lower-cased name. */
    this._map = new Map()

    if (!init) return

    if (init instanceof SnapReqHeaders) {
      for (const [name, value] of init.entries()) this.set(name, value)
    } else if (typeof (/** @type {any} */ (init)[Symbol.iterator]) === "function") {
      for (const [name, value] of /** @type {Iterable<[string, string]>} */ (init)) this.set(name, value)
    } else {
      for (const [name, value] of Object.entries(init)) {
        if (Array.isArray(value)) {
          this.set(name, value.join(", "))
        } else if (value !== undefined && value !== null) {
          this.set(name, String(value))
        }
      }
    }
  }

  /**
   * @param {string} name - Header name (case-insensitive).
   * @param {string | number} value - Header value.
   * @returns {void}
   */
  set(name, value) {
    this._map.set(name.toLowerCase(), {name, value: String(value)})
  }

  /**
   * @param {string} name - Header name (case-insensitive).
   * @returns {string | null} - The header value or null when absent.
   */
  get(name) {
    return this._map.get(name.toLowerCase())?.value ?? null
  }

  /**
   * @param {string} name - Header name (case-insensitive).
   * @returns {boolean} - Whether the header is present.
   */
  has(name) {
    return this._map.has(name.toLowerCase())
  }

  /**
   * @param {string} name - Header name (case-insensitive).
   * @returns {void}
   */
  delete(name) {
    this._map.delete(name.toLowerCase())
  }

  /**
   * @yields {[string, string]} - Name/value pair preserving original casing.
   * @returns {IterableIterator<[string, string]>} - Name/value pairs preserving original casing.
   */
  *entries() {
    for (const {name, value} of this._map.values()) yield [name, value]
  }

  /** @returns {IterableIterator<[string, string]>} - Header entries for structural copying. */
  [Symbol.iterator]() {
    return this.entries()
  }

  /** @returns {[string, string][]} - Name/value pairs preserving original casing. */
  toArray() {
    return [...this.entries()]
  }

  /**
   * Plain object form keyed by the original header casing. Suitable for
   * passing straight to `http.request` or `fetch`.
   * @returns {Record<string, string>} - Header object.
   */
  toObject() {
    /** @type {Record<string, string>} */
    const object = {}

    for (const {name, value} of this._map.values()) object[name] = value

    return object
  }
}
