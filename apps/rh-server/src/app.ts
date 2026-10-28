// The Express app: UI proxy, auth identification, API routes, the built UI, then errors.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { identify, uiProxy } from "./auth.ts";
import { kbProxy } from "./kb/proxy.ts";
import { errorMiddleware, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { routes } from "./routes.ts";
import { projectRoutes } from "./routes-project.ts";
import { sweepRoutes } from "./routes-sweeps.ts";
import { kbRoutes } from "./routes-kb.ts";
import { pluginRoutes } from "./routes-plugins.ts";
import { cycleRoutes } from "./routes-cycle.ts";
import { harnessRoutes } from "./routes-harness.ts";
import { upgradeRoutes } from "./routes-upgrades.ts";
import { StreamHub } from "./sse.ts";

export function createHttpApp(hub: Hub) {
  const streams = new StreamHub();
  const { config, log } = hub;
  const http = express();
  http.disable("x-powered-by");
  // The knowledge-base viewer's paths go straight to it (streamed, before body parsing).
  const viewer = () => hub.current?.kbViewer;
  http.use(kbProxy(viewer, config.allowedHosts));
  http.use(uiProxy({ clientToken: config.clientToken, allowedHosts: config.allowedHosts }));
  http.use(express.json({ limit: "256kb" }));
  http.use(identify({ api: config.apiToken, client: config.clientToken }));
  http.use(routes(hub, streams));
  http.use(projectRoutes(hub));
  http.use(sweepRoutes(hub));
  http.use(kbRoutes(hub));
  http.use(pluginRoutes(hub));
  http.use(cycleRoutes(hub));
  http.use(harnessRoutes(hub));
  http.use(upgradeRoutes(hub));
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
    // /assets/ the hub does not have belong to the viewer.
    http.use(kbProxy(viewer, config.allowedHosts, "assets"));
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
