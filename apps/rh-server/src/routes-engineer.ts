// The engineer's API (spec engineer): ideas, their stages and logs; propose, build, reject, enable.
import express, { type Router } from "express";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { EngineerInvalid, type EngineerExports } from "../plugins/rh.engineer/main.ts";

export function engineerRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const engineer = () => hub.project.plugins.exportsOf<EngineerExports>("rh.engineer");
  const guard = async <T>(work: () => T | Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof EngineerInvalid) throw invalid(error.message);
      throw error;
    }
  };
  router.get("/v1/engineer/ideas", async (_request, response) => void response.json((await engineer()).ideas()));
  router.post("/v1/engineer/ideas", async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== "string") throw invalid("text must be the idea in words");
    const source = request.body?.source === "suggestion" ? "suggestion" : "user";
    response.status(202).json(await guard(async () => (await engineer()).propose(text, source)));
  });
  for (const action of ["build", "reject", "enable"] as const)
    router.post(`/v1/engineer/ideas/:id/${action}`, async (request, response) => {
      const id = int(request.params.id, "id");
      response.json(await guard(async () => (await engineer())[action](id)));
    });
  return router;
}
