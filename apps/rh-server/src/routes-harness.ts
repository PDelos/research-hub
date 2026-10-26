// The harness API (spec harness): quality (the judge's agreement, the current settings over time, replays), the
// replay list, and replaying a variant.
import express, { type Router } from "express";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { BenchmarkInvalid, VariantInvalid, type HarnessExports } from "../plugins/rh.harness/main.ts";

export function harnessRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const harness = () => hub.project.plugins.exportsOf<HarnessExports>("rh.harness");

  r.get("/v1/harness/quality", async (_req, res) => void res.json((await harness()).quality()));
  r.get("/v1/harness/replays", async (req, res) => {
    res.json((await harness()).replays(Math.min(int(req.query.limit, "limit", 50), 200)));
  });
  r.get("/v1/slots", async (_req, res) => void res.json((await harness()).slots()));
  r.get("/v1/slots/benchmarks", async (req, res) => {
    const slot = typeof req.query.slot === "string" ? req.query.slot : undefined;
    res.json((await harness()).benchmarks(slot, 50));
  });
  r.post("/v1/slots/:id/benchmark", async (req, res) => {
    const candidate = req.body?.candidate ?? {};
    if (typeof candidate !== "object" || Array.isArray(candidate)) throw invalid("candidate must be an object");
    try {
      res.json(await (await harness()).runBenchmark(String(req.params.id), candidate));
    } catch (error) {
      if (error instanceof BenchmarkInvalid) throw invalid(error.message);
      throw error;
    }
  });

  r.post("/v1/harness/replay", async (req, res) => {
    try {
      res.json(await (await harness()).replay(req.body?.variant, "user"));
    } catch (error) {
      if (error instanceof VariantInvalid) throw invalid(error.message);
      throw error;
    }
  });
  return r;
}
