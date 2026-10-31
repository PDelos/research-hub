// The harness API (spec harness): quality (the judge's agreement, the current settings over time, replays), the
// replay list, and replaying a variant.
import express, { type Router } from "express";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import { featureExports } from "./feature.ts";
import type { Hub } from "./hub.ts";
import { BenchmarkInvalid, VariantInvalid, type HarnessExports } from "../plugins/rh.harness/main.ts";

export function harnessRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const harness = () => featureExports<HarnessExports>(hub, "rh.harness");

  router.get("/v1/harness/quality", async (_request, response) => void response.json((await harness()).quality()));
  router.get("/v1/harness/replays", async (request, response) => {
    response.json((await harness()).replays(Math.min(int(request.query.limit, "limit", 50), 200)));
  });
  router.get("/v1/attribution", async (request, response) => {
    const days = Math.min(Math.max(int(request.query.days, "days", 30), 1), 365);
    response.json((await harness()).attribution(new Date(Date.now() - days * 86_400_000).toISOString()));
  });
  router.get("/v1/slots", async (_request, response) => void response.json((await harness()).slots()));
  router.get("/v1/slots/benchmarks", async (request, response) => {
    const slot = typeof request.query.slot === "string" ? request.query.slot : undefined;
    response.json((await harness()).benchmarks(slot, 50));
  });
  router.post("/v1/slots/:id/benchmark", async (request, response) => {
    const candidate = request.body?.candidate ?? {};
    if (typeof candidate !== "object" || Array.isArray(candidate)) throw invalid("candidate must be an object");
    try {
      response.json(await (await harness()).runBenchmark(String(request.params.id), candidate));
    } catch (error) {
      if (error instanceof BenchmarkInvalid) throw invalid(error.message);
      throw error;
    }
  });

  router.post("/v1/harness/replay", async (request, response) => {
    try {
      response.json(await (await harness()).replay(request.body?.variant, "user"));
    } catch (error) {
      if (error instanceof VariantInvalid) throw invalid(error.message);
      throw error;
    }
  });
  return router;
}
