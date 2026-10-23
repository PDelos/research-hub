// The Express app: UI proxy, auth identification, API routes, the built UI, then errors.
import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { identify, uiProxy } from "./auth.ts";
import { errorMiddleware, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { routes } from "./routes.ts";
import { StreamHub } from "./sse.ts";

export function createHttpApp(hub: Hub) {
  const streams = new StreamHub();
  const { config, log } = hub;
  const http = express();
  http.disable("x-powered-by");
  http.use(uiProxy({ clientToken: config.clientToken, allowedHosts: config.allowedHosts }));
  http.use(express.json({ limit: "256kb" }));
  http.use(identify({ api: config.apiToken, client: config.clientToken }));
  http.use(routes(hub, streams));
  if (existsSync(join(config.uiDir, "index.html"))) {
    http.use(express.static(config.uiDir, { index: "index.html", maxAge: "1h" }));
    http.get(/^\/(?!v1\/|ui\/).*/, (_req, res) => res.sendFile(join(config.uiDir, "index.html")));
  } else {
    log.warn("ui.missing", { uiDir: config.uiDir, hint: "npm run build -w rh-client-browser" });
  }
  http.use((req) => {
    throw notFound(`No route ${req.method} ${req.path}`);
  });
  http.use(errorMiddleware(log));
  return { http, streams };
}
