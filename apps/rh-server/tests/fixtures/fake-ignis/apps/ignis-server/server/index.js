// A stand-in for Ignis in tests: serves a page and echoes paths, upgrades /ws, and exits on /api/crash.
const http = require("node:http");
const fs = require("node:fs");
const server = http.createServer((req, res) => {
  if (req.url === "/api/crash") {
    res.end("bye");
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.setHeader("content-type", "text/html");
    return res.end(
      `<!doctype html><title>Fake Obsidian</title>vaults:${fs.readdirSync(process.env.VAULT_ROOT).join(",")}`,
    );
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      path: req.url,
      method: req.method,
      host: req.headers.host,
      auth: req.headers.authorization ?? null,
    }),
  );
});
server.on("upgrade", (req, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: " + req.url + "\r\n\r\n",
  );
  socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")]));
});
server.listen(Number(process.env.PORT));
