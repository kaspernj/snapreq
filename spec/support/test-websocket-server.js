// @ts-check

import {WebSocketServer} from "ws"

/**
 * Starts a minimal WebSocket server implementing just enough of the protocol
 * the client speaks (session establishment, request/response, channel and
 * connection round-trips) to exercise `SnapReqWebSocketClient` end to end.
 * @returns {Promise<{url: string, receivedMessages: Array<Record<string, any> & {requestUrl?: string}>, releaseSession: (id: string) => void, releaseSessionGone: (id: string) => void, waitForSessionResume: (id: string) => Promise<void>, close: () => Promise<void>}>} - Server handle.
 */
export async function startTestWebSocketServer() {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0})
  /** @type {Array<Record<string, any> & {requestUrl?: string}>} */
  const receivedMessages = []
  /** @type {Map<string, () => void>} */
  const pendingSessions = new Map()
  /** @type {Map<string, () => void>} */
  const pendingSessionGoneResponses = new Map()
  /** @type {Map<string, () => void>} */
  const sessionResumeWaiters = new Map()
  let sessionSequence = 0

  server.on("connection", (socket, request) => {
    sessionSequence += 1
    const sessionId = `session-${sessionSequence}`
    /** @param {Record<string, any>} message - Outgoing message. */
    const send = (message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }

    const manualSessionId = new URL(request.url || "/", "ws://localhost").searchParams.get("manual-session")
    if (manualSessionId) {
      pendingSessions.set(manualSessionId, () => send({type: "session-established", sessionId}))
    } else if (!request.url?.includes("no-session")) {
      const establishSession = () => send({type: "session-established", sessionId})
      if (request.url?.includes("delay-session")) setTimeout(establishSession, 50)
      else establishSession()
    }

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString())
      receivedMessages.push({...message, requestUrl: request.url})

      if (message.type === "request" && message.path !== "/hang") {
        send({
          type: "response",
          id: message.id,
          statusCode: 200,
          statusMessage: "OK",
          body: JSON.stringify({echoed: {method: message.method, path: message.path, body: message.body}})
        })
      } else if (message.type === "subscribe") {
        const acknowledge = () => {
          send({type: "subscribed", channel: message.channel, params: message.params})
          send({type: "event", channel: message.channel, payload: {hello: "world"}})
        }
        if (message.channel === "delayed-updates") setTimeout(acknowledge, 50)
        else acknowledge()
      } else if (message.type === "channel-subscribe") {
        const acknowledge = () => {
          send({type: "channel-subscribed", subscriptionId: message.subscriptionId})
          send({type: "channel-message", subscriptionId: message.subscriptionId, body: {tick: 1}})
        }
        if (message.channelType === "DelayedChannel") setTimeout(acknowledge, 50)
        else acknowledge()
      } else if (message.type === "connection-open") {
        const acknowledge = () => {
          send({type: "connection-opened", connectionId: message.connectionId})
          send({type: "connection-message", connectionId: message.connectionId, body: {welcome: true}})
        }
        if (message.connectionType === "DelayedConnection") setTimeout(acknowledge, 50)
        else acknowledge()
      } else if (message.type === "session-resume") {
        if (request.url?.includes("session-gone-on-resume")) {
          const manualSessionGoneId = new URL(request.url || "/", "ws://localhost").searchParams.get("manual-session-gone")
          if (manualSessionGoneId) {
            pendingSessionGoneResponses.set(manualSessionGoneId, () => send({type: "session-gone"}))
            sessionResumeWaiters.get(manualSessionGoneId)?.()
            sessionResumeWaiters.delete(manualSessionGoneId)
          } else {
            send({type: "session-gone"})
          }
        } else {
          send({type: "session-resumed", sessionId: message.sessionId})
        }
      }
    })
  })

  await new Promise((resolve) => server.once("listening", () => resolve(null)))

  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Failed to bind websocket server")

  return {
    url: `ws://127.0.0.1:${address.port}`,
    receivedMessages,
    releaseSession: (id) => {
      const establishSession = pendingSessions.get(id)
      if (!establishSession) throw new Error(`No pending session ${id}`)
      pendingSessions.delete(id)
      establishSession()
    },
    releaseSessionGone: (id) => {
      const sendSessionGone = pendingSessionGoneResponses.get(id)
      if (!sendSessionGone) throw new Error(`No pending session-gone response ${id}`)
      pendingSessionGoneResponses.delete(id)
      sendSessionGone()
    },
    waitForSessionResume: (id) => new Promise((resolve) => {
      if (sessionResumeWaiters.has(id)) throw new Error(`Session-resume waiter already exists ${id}`)
      sessionResumeWaiters.set(id, resolve)
    }),
    close: () => new Promise((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    })
  }
}
