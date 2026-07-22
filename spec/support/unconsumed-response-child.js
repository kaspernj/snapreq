// @ts-check

import http from "node:http"
import zlib from "node:zlib"
import SnapReq from "../../src/snap-req.js"

const uncaught = []
let responseClosed = false
let socketClosed = false

process.on("uncaughtException", (error) => uncaught.push(error.name))

const server = http.createServer((request, response) => {
  request.socket.once("close", () => { socketClosed = true })
  response.writeHead(200, {"Content-Type": "text/plain", "Content-Encoding": "gzip"})
  const gzip = zlib.createGzip()
  gzip.pipe(response)
  gzip.write("partial")
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()

if (!address || typeof address === "string") throw new Error("test server did not bind")

const client = new SnapReq({baseUrl: `http://127.0.0.1:${address.port}`, transport: "node"})
const response = await client.get("/unconsumed", {timeoutMs: 30})

response.nodeStream?.once("close", () => { responseClosed = true })
await new Promise((resolve) => setTimeout(resolve, 100))
client.close()
await new Promise((resolve) => server.close(resolve))
process.stdout.write(JSON.stringify({uncaught, responseClosed, socketClosed}))
