// The MCP endpoint (spec mcp; design v1-9 D1): stateless Streamable HTTP at POST /mcp, behind the read-only
// RH_MCP_TOKEN; off without the token or with the rh.mcp add-on disabled.
import { timingSafeEqual } from "node:crypto";
import express, { type Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Hub } from "./hub.ts";
import type { McpExports } from "../plugins/rh.mcp/main.ts";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function mcpRoutes(hub: Hub): Router {
  const r = express.Router();
  const refuse = (res: express.Response, status: number, message: string) =>
    void res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  r.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    const token = hub.config.mcpToken;
    if (!token) return refuse(res, 404, "MCP is off: set RH_MCP_TOKEN in this project's .env");
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!given || !same(given, token))
      return refuse(res, 401, "a valid MCP token is required (Authorization: Bearer <RH_MCP_TOKEN>)");
    const plugin = hub.project.plugins.kernel.list().find((p) => p.id === "rh.mcp");
    if (!plugin || plugin.state === "disabled")
      return refuse(res, 404, "MCP is off: the MCP server add-on is disabled");
    const server = (await hub.project.plugins.exportsOf<McpExports>("rh.mcp")).server();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  r.all("/mcp", (_req, res) => refuse(res, 405, "use POST (Streamable HTTP without sessions)"));
  return r;
}
