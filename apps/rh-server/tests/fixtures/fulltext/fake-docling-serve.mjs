#!/usr/bin/env node
// A stand-in for `docling-serve run --host H --port P`: /health and /v1/convert/file answering fixed markdown.
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
createServer((req, res) => {
  if (req.url === "/health") return void res.end('{"status":"ok"}');
  req.resume();
  req.on("end", () =>
    res.end(
      JSON.stringify({
        document: { md_content: "## Introduction\n\nStarted by the hub.\n\n## Methods\n\nSupervised." },
      }),
    ),
  );
}).listen(port, "127.0.0.1");
