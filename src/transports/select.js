// @ts-check

import {SnapReqError} from "../errors.js"
import FetchTransport from "./fetch-transport.js"
import XhrTransport from "./xhr-transport.js"

/**
 * @typedef {"auto" | "node" | "fetch" | "xhr"} TransportName
 */

/**
 * @typedef {object} Transport
 * @property {import("../capabilities.js").TransportCapabilities} capabilities - Supported capabilities.
 * @property {(request: import("../snap-req.js").NormalizedRequest) => Promise<import("../response.js").default>} performRequest - Perform a request.
 * @property {() => void} [close] - Optional resource cleanup.
 */

/**
 * Detects the JavaScript runtime so `auto` can pick the right transport.
 * @returns {"node" | "react-native" | "browser" | "unknown"} - Detected runtime.
 */
export function detectRuntime() {
  const navigatorRef = /** @type {any} */ (globalThis).navigator

  if (navigatorRef && navigatorRef.product === "ReactNative") return "react-native"
  if (typeof process !== "undefined" && Boolean(process.versions?.node)) return "node"
  if (typeof window !== "undefined" && typeof document !== "undefined") return "browser"

  return "unknown"
}

/**
 * @param {object} config - Node transport configuration.
 * @returns {Promise<Transport>} - A Node transport instance.
 */
async function createNodeTransport(config) {
  const {default: NodeTransport} = await import("./node-transport.js")

  return new NodeTransport(config)
}

/**
 * Resolves a transport for the requested preference. Returns the preference
 * untouched when it is already a transport instance. The Node transport is
 * imported dynamically so web/Expo bundlers never pull in `node:*` modules.
 * @param {TransportName | Transport | undefined} preference - Requested transport.
 * @param {object} nodeConfig - Configuration forwarded to the Node transport.
 * @returns {Promise<Transport>} - The resolved transport.
 */
export async function selectTransport(preference, nodeConfig) {
  if (preference && typeof preference === "object" && typeof (/** @type {any} */ (preference).performRequest) === "function") {
    return /** @type {Transport} */ (preference)
  }

  const choice = /** @type {TransportName} */ (preference || "auto")

  if (choice === "node") return await createNodeTransport(nodeConfig)
  if (choice === "fetch") return new FetchTransport()
  if (choice === "xhr") return new XhrTransport()

  if (choice !== "auto") {
    throw new SnapReqError(`Unknown transport "${choice}". Use "auto", "node", "fetch", "xhr" or a transport instance.`)
  }

  const runtime = detectRuntime()

  if (runtime === "node") return await createNodeTransport(nodeConfig)
  if (FetchTransport.isAvailable()) return new FetchTransport()
  if (XhrTransport.isAvailable()) return new XhrTransport()
  if (typeof process !== "undefined" && Boolean(process.versions?.node)) return await createNodeTransport(nodeConfig)

  throw new SnapReqError("No suitable transport found: this platform has no fetch, XMLHttpRequest or Node http support.")
}
