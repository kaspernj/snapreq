# snapreq

A cross-platform HTTP and WebSocket client with **one API** across Node, the web, Expo and React Native.

The same code runs everywhere. Where a platform cannot provide a feature (Unix sockets in a browser, request-body compression over `fetch`, …) snapreq raises a clear `SnapReqUnsupportedFeatureError` instead of silently changing behaviour — so the API is identical and the gaps are explicit.

- Zero runtime dependencies.
- Picks the right transport at runtime: Node `http`/`https`, `fetch`, or `XMLHttpRequest`.
- `node:*` modules are loaded with a dynamic `import()` from the Node transport only, so web/Expo bundlers (Metro, webpack, …) never try to bundle them.
- ESM + JSDoc types, checked with `tsc`.

## Install

```sh
npm install snapreq
```

## Imports

snapreq has **no barrel entry point** — you import each piece from its own subpath so a bundler (Metro/Expo, webpack, …) only pulls in what you use, and the HTTP client never drags the WebSocket client into your bundle:

```js
import SnapReq from "snapreq"                       // the HTTP client
import SnapReqWebSocketClient from "snapreq/websocket"
import {SnapReqHttpError, SnapReqUnsupportedFeatureError} from "snapreq/errors"
import {defaultRetryableError} from "snapreq/retry"
import SnapReqResponse from "snapreq/response"
import SnapReqHeaders from "snapreq/headers"
```

## HTTP

```js
import SnapReq from "snapreq"

const client = new SnapReq({baseUrl: "https://api.example.com"})

const response = await client.get("/users", {query: {page: 1}})
const users = await response.json()

await client.post("/users", {name: "Ada"})
```

Every call returns a `SnapReqResponse`:

```js
response.status          // 200
response.ok              // status in 200..299
response.headers.get("content-type")
await response.json()    // parsed JSON (null for an empty body)
await response.text()    // UTF-8 string
await response.bytes()   // Uint8Array
await response.buffer()  // Node Buffer (Node only)
```

`request()` does **not** throw on a non-2xx status by default (like `fetch`). Pass `throwOnError: true` (per request or on the client) to get a `SnapReqHttpError` carrying `status`, `responseText` and the `response`.

### Client options

```js
new SnapReq({
  baseUrl,        // origin (and optional base path) prefixed onto relative paths
  headers,        // default headers — object or a factory `() => ({...})` for dynamic auth
  retry,          // default retry policy (see below)
  throwOnError,   // throw SnapReqHttpError on non-2xx (default false)
  timeoutMs,      // default request/body timeout in milliseconds; per-request 0 disables it
  credentials,    // fetch credentials mode: "omit" | "same-origin" | "include"
  transport,      // "auto" (default) | "node" | "fetch" | "xhr" | a transport instance

  // Node transport only:
  socketPath,     // connect over a Unix domain socket
  tls,            // {ca, cert, key, rejectUnauthorized}
  keepAlive       // reuse connections (default true)
})
```

### Timeouts

Set `timeoutMs` on the client or a single request to abort stalled requests. The timeout covers one request attempt, including response headers and body reads through `json()`, `text()`, `bytes()`, `buffer()`, or `stream()`. A timed-out request rejects with `SnapReqTimeoutError`; caller `signal` cancellation rejects with `SnapReqAbortError`. Both controls cooperatively abort the active transport and interrupt retry waits without starting another attempt.

```js
const client = new SnapReq({baseUrl: "https://api.example.com", timeoutMs: 120000})

await client.get("/slow", {timeoutMs: 5000})
await client.get("/long-running", {timeoutMs: 0}) // disable the client default for this call
```

### Retry

Retries transient network errors and retryable HTTP statuses (502/503/504 by default). Only applies to buffered requests — never to streamed bodies.

```js
await client.get("/flaky", {retry: true})
await client.get("/flaky", {retry: {tries: 5, waitMs: 200, retryableStatuses: [503]}})

// Compose extra rules on top of the default network classifier:
import {defaultRetryableError} from "snapreq/retry"

await client.get("/x", {retry: {shouldRetry: (error) => defaultRetryableError(error) || isMyCase(error)}})
```

### Streaming

```js
const response = await client.requestStream({method: "GET", path: "/logs"})

for await (const chunk of response.stream()) {
  process.stdout.write(chunk) // chunk is a Uint8Array
}
```

`requestStream()` requires a transport that supports response streaming and never retries. On Node the raw stream is also available as `response.nodeStream`.

### Request-body compression (Node)

```js
await client.post("/upload", largePayload, {bodyCompression: "gzip"}) // gzip | deflate | br | zstd
```

Over `fetch`/`xhr` this raises `SnapReqUnsupportedFeatureError`.

### Capabilities

Each transport advertises what it can do. Inspect them when you need to branch on platform support:

```js
const caps = await client.capabilities()
// {unixSocket, tlsClientCert, requestCompression, responseStreaming, requestStreaming, keepAlive, abort}
```

| Capability          | Node | fetch | xhr |
| ------------------- | :--: | :---: | :-: |
| unixSocket          |  ✅  |  —    |  —  |
| tlsClientCert       |  ✅  |  —    |  —  |
| requestCompression  |  ✅  |  —    |  —  |
| responseStreaming   |  ✅  |  ✅   |  —  |
| requestStreaming    |  ✅  |  —    |  —  |
| keepAlive           |  ✅  |  —    |  —  |
| abort               |  ✅  |  ✅   |  ✅ |

## WebSocket

A WebSocket client over `globalThis.WebSocket` with auto-reconnect, session resumption, request/response calls, channel subscriptions and 1:1 connections.

```js
import SnapReqWebSocketClient from "snapreq/websocket"

const client = new SnapReqWebSocketClient({url: "wss://example.com/websocket"})

const controller = new AbortController()
await client.connect({timeoutMs: 5000, signal: controller.signal})

// Request/response over the socket
const response = await client.post("/things", {name: "thing"}, {timeoutMs: 5000, signal: controller.signal})
response.json()

// Channel subscription
const unsubscribe = await client.subscribeAndWait("updates", {timeoutMs: 5000, signal: controller.signal}, (payload) => console.log(payload))

// 1:1 connection
const connection = client.openConnection("ChatConnection", {timeoutMs: 5000, signal: controller.signal, onMessage: (body) => console.log(body)})
await connection.ready
connection.sendMessage({text: "hi"})
```

`timeoutMs` and `signal` are also accepted by `get`, `request`, `subscribe`, `subscribeChannel`, and `waitForReady`. WebSocket timeouts intentionally reject with Awaitery's `TimeoutError`, while WebSocket cancellation rejects with the exact `signal.reason`; unlike HTTP operations, these errors are not mapped to SnapReq error classes. A failed connect deadline closes only a socket created solely for that operation; a shared in-flight socket remains alive for other connect-dependent operations. Request and readiness failures remove only their own pending entry or handle.

Optional adapters: `networkMonitor` (gate reconnects on online state), `sessionStore` (persist the session id across reloads) and `deserialize` (a `(value) => value` transform applied inside `response.json()` so an app can re-hydrate its own wire format).

## Hermes Compose development

The repository includes a task-isolated Node 24 development environment for
Hermes/Threadwire work. It mounts one exact worktree into `/workspace`; the
dependency, npm-cache, and Codex state volumes are scoped by the required
Compose project name. There are no support services, host ports, or fixed
container names. The development-only `@kaspernj/hermes-compose` package owns
the lifecycle, provider, process and signal handling, bootstrap, proof, smoke
acceptance, and exact cleanup. SnapReq owns only `hermes.config.js` and its
checked-in Compose/Dockerfile wiring.

From the outer Hermes Docker host, allocate a self-contained Git checkout
(with its own `.git` directory) directly below
`/opt/hermes-dind-shared/worktrees/snapreq` and keep its task name identical to
the Compose suffix:

```sh
export HERMES_SOURCE_PATH=/opt/hermes-dind-shared/worktrees/snapreq/10575
export HERMES_COMPOSE_PROJECT=snapreq-10575

npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose validate
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose config
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose build --pull
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose up
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose exec npm ci
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose proof
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose down
```

Codex authentication is initialized into the task-owned volume from one
explicit, existing Docker volume in the private DinD daemon. That source
volume must contain `/auth.json`; it is mounted read-only only for the one-off
initializer and never attached to the long-running service:

```sh
export HERMES_CODEX_AUTH_VOLUME=<existing-auth-volume>
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose init-codex
```

Threadwire remains on the outer host. The package launches it through its
provider, which runs Codex in the `dev` service at `/workspace`:

```sh
export THREADWIRE_TARGET=telegram:-1001234567890:42
npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose threadwire --prompt 'Inspect the project.'
```

Use the pinned `npm exec` `down` command above for ordinary teardown; it
preserves task state. Volume/image deletion requires the separate, exact
confirmation:

```sh
HERMES_PURGE_PROJECT="$HERMES_COMPOSE_PROJECT" npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose purge
```

The two-stack acceptance entry point is
`npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose smoke`.
See [AGENTS.md](AGENTS.md) for the authoritative boundary, parallel-allocation,
verification, smoke-test, and non-Hermes workflow rules.

## License

ISC
