// @ts-check

import {WebSocketServer} from "ws"

/**
 * Starts a minimal WebSocket server implementing just enough of the protocol
 * the client speaks (session establishment, request/response, channel and
 * connection round-trips) to exercise `SnapReqWebSocketClient` end to end.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} - Server handle.
 */
export async function startTestWebSocketServer() {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0})

  server.on("connection", (socket) => {
    /** @param {Record<string, any>} message - Outgoing message. */
    const send = (message) => socket.send(JSON.stringify(message))

    send({type: "session-established", sessionId: "session-1"})

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString())

      if (message.type === "request") {
        send({
          type: "response",
          id: message.id,
          statusCode: 200,
          statusMessage: "OK",
          body: JSON.stringify({echoed: {method: message.method, path: message.path, body: message.body}})
        })
      } else if (message.type === "subscribe") {
        send({type: "subscribed", channel: message.channel, params: message.params})
        send({type: "event", channel: message.channel, payload: {hello: "world"}})
      } else if (message.type === "channel-subscribe") {
        send({type: "channel-subscribed", subscriptionId: message.subscriptionId})
        send({type: "channel-message", subscriptionId: message.subscriptionId, body: {tick: 1}})
      } else if (message.type === "connection-open") {
        send({type: "connection-opened", connectionId: message.connectionId})
        send({type: "connection-message", connectionId: message.connectionId, body: {welcome: true}})
      } else if (message.type === "session-resume") {
        send({type: "session-resumed", sessionId: message.sessionId})
      }
    })
  })

  await new Promise((resolve) => server.once("listening", () => resolve(null)))

  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Failed to bind websocket server")

  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
