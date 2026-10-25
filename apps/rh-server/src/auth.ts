// Bearer tokens compared as sha256 digests with timingSafeEqual. The API token is for external callers; the client
// token is held by the in-process UI proxy, which only serves same-origin requests to hosts we answer for.
// Adapted from disler/pi-durable-news-agent (auth.ts and the hub's guard.ts).
import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiFault } from "./errors.ts";
import type { Logger } from "./logger.ts";

export type Principal = "api" | "client";
const digest = (token: string) => createHash("sha256").update(token).digest();

export function identify(tokens: { api: string; client: string }): RequestHandler {
  const known = [
    ["api", digest(tokens.api)],
    ["client", digest(tokens.client)],
  ] as const;
  return (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (presented) {
      const actual = digest(presented);
      for (const [principal, expected] of known)
        if (timingSafeEqual(actual, expected)) res.locals.principal = principal;
    }
    next();
  };
}

export function requireAuth(log: Logger): RequestHandler {
  return (req, res, next) => {
    if (res.locals.principal) return next();
    log.warn("auth.unauthorized", { method: req.method, path: req.path });
    res.set("WWW-Authenticate", 'Bearer realm="research-hub"');
    throw new ApiFault("unauthorized", "Missing or invalid token");
  };
}

/**
 * The UI proxy: /ui/v1/* is served as /v1/* with the client token injected server-side. It answers only Host
 * headers it serves (blocks DNS rebinding), only same-origin browsers (blocks CSRF), and only JSON writes (forces a
 * CORS preflight that cross-origin pages cannot pass).
 */
export function uiProxy(options: { clientToken: string; allowedHosts: Set<string> }): RequestHandler {
  const fault = (res: any, status: number, code: string, message: string) =>
    void res.status(status).json({ error: { code, message } });
  // Compare host names only: a rebinding attack controls the name, and ports may be remapped (Docker, tests).
  const hostname = (host: string) =>
    host
      .toLowerCase()
      .replace(/:\d+$/, "")
      .replace(/^\[(.*)\]$/, "$1");
  return (req, res, next) => {
    if (!req.url.startsWith("/ui/v1/")) return next();
    const host = hostname(req.headers.host ?? "");
    if (!options.allowedHosts.has(host)) return fault(res, 421, "invalid", `Unknown Host header: ${host}`);
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = hostname(new URL(origin).host);
      } catch {}
      if (!options.allowedHosts.has(originHost))
        return fault(res, 403, "forbidden", "Cross origin requests are not allowed");
    }
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none")
      return fault(res, 403, "forbidden", "Cross site requests are not allowed");
    if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json"))
      return fault(res, 415, "invalid", "JSON required");
    req.url = req.url.slice(3);
    req.headers.authorization = `Bearer ${options.clientToken}`;
    next();
  };
}
