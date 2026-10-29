#!/usr/bin/env node
// A stand-in for `docling-serve run --host H --port P`: /health and the async convert API with fixed markdown.
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const md = "## Introduction\n\nStarted by the hub.\n\n## Methods\n\nSupervised.";
createServer((request, response) => {
  if (request.url === "/health") return void response.end('{"status":"ok"}');
  if (request.url?.startsWith("/v1/status/poll/")) return void response.end('{"task_status":"success"}');
  if (request.url?.startsWith("/v1/result/"))
    return void response.end(JSON.stringify({ document: { md_content: md } }));
  request.resume();
  request.on("end", () => response.end('{"task_id":"t1","task_status":"pending"}'));
}).listen(port, "127.0.0.1");
