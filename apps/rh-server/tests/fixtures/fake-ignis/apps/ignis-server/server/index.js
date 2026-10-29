// A stand-in for Ignis in tests: serves a page and echoes paths, upgrades /ws, and exits on /api/crash.
const http = require("node:http");
const fs = require("node:fs");
const server = http.createServer((request, response) => {
  if (request.url === "/api/crash") {
    response.end("bye");
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (request.url === "/" || request.url.startsWith("/?")) {
    response.setHeader("content-type", "text/html");
    return response.end(
      `<!doctype html><title>Fake Obsidian</title>vaults:${fs.readdirSync(process.env.VAULT_ROOT).join(",")}`,
    );
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      path: request.url,
      method: request.method,
      host: request.headers.host,
      auth: request.headers.authorization ?? null,
    }),
  );
});
server.on("upgrade", (request, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: " +
      request.url +
      "\r\n\r\n",
  );
  socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")]));
});
server.listen(Number(process.env.PORT));
