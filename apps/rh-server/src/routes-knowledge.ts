// The knowledge loop API (spec knowledge-loop): reviews and charter proposals; approve, reject, undo; a review now.
import express, { type Router } from "express";
import type { KnowledgeView } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { KnowledgeInvalid, type KnowledgeExports } from "../plugins/rh.knowledge/main.ts";

export function knowledgeRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const knowledge = () => hub.project.plugins.exportsOf<KnowledgeExports>("rh.knowledge");
  const guard = async <T>(fn: () => T | Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof KnowledgeInvalid) throw invalid(error.message);
      throw error;
    }
  };

  r.get("/v1/knowledge", async (_req, res) => {
    const k = await knowledge();
    const view: KnowledgeView = {
      running: k.busy(),
      reviews: k.reviews(10),
      proposals: k.proposals(),
      finders: await k.finders(),
    };
    res.json(view);
  });
  r.post("/v1/knowledge/review", async (_req, res) => {
    const k = await knowledge();
    if (k.busy()) throw invalid("a knowledge review is already running");
    // One review-model call and a few Jev calls: it continues in the background and shows in GET /v1/knowledge.
    void k.review("user").catch((error) => hub.log.warn("knowledge.review_failed", { error: String(error) }));
    res.status(202).json({ started: true });
  });
  r.post("/v1/knowledge/proposals/:id/approve", async (req, res) => {
    const id = int(req.params.id, "id", 0);
    res.json(await guard(async () => (await knowledge()).approve(id)));
  });
  r.post("/v1/knowledge/proposals/:id/reject", async (req, res) => {
    const id = int(req.params.id, "id", 0);
    const reason = req.body?.reason;
    if (reason !== undefined && typeof reason !== "string") throw invalid("reason must be text");
    res.json(await guard(async () => (await knowledge()).reject(id, reason)));
  });
  r.post("/v1/knowledge/proposals/:id/undo", async (req, res) => {
    const id = int(req.params.id, "id", 0);
    res.json(await guard(async () => (await knowledge()).undo(id)));
  });
  return r;
}
