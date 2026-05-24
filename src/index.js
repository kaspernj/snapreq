// @ts-check

import SnapReq from "./snap-req.js"

export default SnapReq
export {default as SnapReq} from "./snap-req.js"
export {default as SnapReqResponse} from "./response.js"
export {default as SnapReqHeaders} from "./headers.js"
export {
  SnapReqError,
  SnapReqHttpError,
  SnapReqUnsupportedFeatureError,
  SnapReqAbortError
} from "./errors.js"
export {defaultRetryableError} from "./retry.js"
export {detectRuntime, selectTransport} from "./transports/select.js"
export {default as FetchTransport} from "./transports/fetch-transport.js"
export {default as XhrTransport} from "./transports/xhr-transport.js"

// The WebSocket client is exported from its own module so importing the HTTP
// client never pulls WebSocket code into a bundle that does not need it.
export {default as SnapReqWebSocketClient} from "./websocket/websocket-client.js"
