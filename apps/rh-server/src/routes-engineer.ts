// The engineer's API (spec engineer): ideas, their stages and logs; propose, build, reject, enable.
import express, { type Router } from "express";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { EngineerInvalid, type EngineerExports } from "../plugins/rh.engineer/main.ts";

export function engineerRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const engineer = () => hub.project.plugins.exportsOf<EngineerExports>("rh.engineer");
  const guard = async <T>(fn: () => T | Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EngineerInvalid) throw invalid(error.message);
      throw error;
    }
  };
  r.get("/v1/engineer/ideas", async (_req, res) => void res.json((await engineer()).ideas()));
  r.post("/v1/engineer/ideas", async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string") throw invalid("text must be the idea in words");
    const source = req.body?.source === "suggestion" ? "suggestion" : "user";
    res.status(202).json(await guard(async () => (await engineer()).propose(text, source)));
  });
  for (const action of ["build", "reject", "enable"] as const)
    r.post(`/v1/engineer/ideas/:id/${action}`, async (req, res) => {
      const id = int(req.params.id, "id");
      res.json(await guard(async () => (await engineer())[action](id)));
    });
  return r;
}
