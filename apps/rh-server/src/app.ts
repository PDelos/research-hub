// The Express app: UI proxy, auth identification, API routes, the built UI, then errors.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { identify, uiProxy } from "./auth.ts";
import { errorMiddleware, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { routes } from "./routes.ts";
import { projectRoutes } from "./routes-project.ts";
import { sweepRoutes } from "./routes-sweeps.ts";
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
  http.use(projectRoutes(hub));
  http.use(sweepRoutes(hub));
  const indexFile = join(config.uiDir, "index.html");
  if (existsSync(indexFile)) {
    // The page title names the project, so several project tabs are easy to tell apart.
    const title = `${config.projectName} · Research Hub`;
    const page = readFileSync(indexFile, "utf8").replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
    const sendPage = (_req: express.Request, res: express.Response) =>
      void res.type("html").set("cache-control", "no-cache").send(page);
    http.get("/", sendPage);
    http.get("/index.html", sendPage);
    http.use(express.static(config.uiDir, { index: false, maxAge: "1h" }));
    http.get(/^\/(?!v1\/|ui\/).*/, sendPage);
  } else {
    log.warn("ui.missing", { uiDir: config.uiDir, hint: "npm run build -w rh-client-browser" });
  }
  http.use((req) => {
    throw notFound(`No route ${req.method} ${req.path}`);
  });
  http.use(errorMiddleware(log));
  return { http, streams };
}
