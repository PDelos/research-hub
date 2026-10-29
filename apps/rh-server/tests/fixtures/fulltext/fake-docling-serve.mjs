#!/usr/bin/env node
// A stand-in for `docling-serve run --host H --port P`: /health and the async convert API with fixed markdown.
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const md = "## Introduction\n\nStarted by the hub.\n\n## Methods\n\nSupervised.";
createServer((req, res) => {
  if (req.url === "/health") return void res.end('{"status":"ok"}');
  if (req.url?.startsWith("/v1/status/poll/")) return void res.end('{"task_status":"success"}');
  if (req.url?.startsWith("/v1/result/")) return void res.end(JSON.stringify({ document: { md_content: md } }));
  req.resume();
  req.on("end", () => res.end('{"task_id":"t1","task_status":"pending"}'));
}).listen(port, "127.0.0.1");
