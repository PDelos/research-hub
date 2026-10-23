// The viewer on the hub's own origin (design D6; trial finding 1): Ignis's page at /kb/ (its assets are relative),
// plus the absolute paths it calls (/api/, /ws, /vault-files/, /downloads/, and /assets/ after the hub's own
// files). Same guard as the UI proxy: only host names the hub answers for, no cross-site requests, and WebSockets
// only from the hub's own origin.
import http, { type IncomingMessage } from "node:http";
import net, { type Socket } from "node:net";
import type { RequestHandler } from "express";
import type { KbViewer } from "./viewer.ts";

export const VIEWER_PREFIXES = /^\/(api|ws|vault-files|downloads)(\/|\?|$)/;

const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");

/** Why a browser request to the viewer must be refused, or undefined when it may pass. */
export function refusal(req: IncomingMessage, allowedHosts: Set<string>): string | undefined {
  if (!allowedHosts.has(hostname(req.headers.host ?? ""))) return "unknown host";
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost.toLowerCase() !== String(req.headers.host).toLowerCase()) return "cross-origin request";
  }
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "cross-site request";
  return undefined;
}

/** Map a hub path to the viewer's path, or undefined if it is not the viewer's. */
export function viewerPath(url: string, includeAssets = false): string | undefined {
  if (url === "/kb") return "/";
  if (url.startsWith("/kb/") || url.startsWith("/kb?")) return url.slice(3) || "/";
  if (VIEWER_PREFIXES.test(url)) return url;
  if (includeAssets && url.startsWith("/assets/")) return url;
  return undefined;
}

function unavailablePage(status: ReturnType<KbViewer["status"]>): string {
  return `<!doctype html><meta charset="utf-8"><title>Knowledge base</title><body style="font:14px system-ui;padding:24px;color:#6b6b66">The knowledge base viewer is ${status.state}${status.reason ? `: ${status.reason}` : ""}.</body>`;
}

/** Express middleware for the viewer's paths. `assets` mode only handles /assets/ (mount it after the hub's static files). */
export function kbProxy(viewer: () => KbViewer | undefined, allowedHosts: Set<string>, mode: "paths" | "assets" = "paths"): RequestHandler {
  return (req, res, next) => {
    const path = mode === "assets" ? (req.url.startsWith("/assets/") ? req.url : undefined) : viewerPath(req.url);
    if (path === undefined) return next();
    const why = refusal(req, allowedHosts);
    if (why) return void res.status(403).json({ error: { code: "forbidden", message: `Knowledge base viewer: ${why}` } });
    const v = viewer();
    const target = v?.target();
    if (!target) {
      if (mode === "assets") return next();
      return void res.status(503).type("html").send(unavailablePage(v?.status() ?? { state: "disabled", obsidianVersion: "", restarts: 0 }));
    }
    const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
    delete headers.authorization;
    const upstream = http.request({ ...target, path, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.status(502).type("html").send(unavailablePage({ state: "crashed", obsidianVersion: "", restarts: 0 }));
      else res.end();
    });
    req.pipe(upstream);
  };
}

/** WebSocket upgrades for the viewer's live sync (/ws, also /kb/ws). */
export function kbUpgrade(viewer: () => KbViewer | undefined, allowedHosts: Set<string>) {
  return (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = viewerPath(req.url ?? "");
    const target = viewer()?.target();
    if (!path || refusal(req, allowedHosts) || !target) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(target.port, target.host, () => {
      const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
      delete headers.authorization;
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
      upstream.write(`${req.method} ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    // Either side closing ends the other, so no half-open connection outlives the browser or the viewer.
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  };
}
