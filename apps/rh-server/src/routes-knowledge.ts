// The knowledge loop API (spec knowledge-loop): reviews and charter proposals; approve, reject, undo; a review now.
import express, { type Router } from "express";
import type { KnowledgeView } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { KnowledgeInvalid, type KnowledgeExports } from "../plugins/rh.knowledge/main.ts";

export function knowledgeRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const knowledge = () => hub.project.plugins.exportsOf<KnowledgeExports>("rh.knowledge");
  const guard = async <T>(work: () => T | Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof KnowledgeInvalid) throw invalid(error.message);
      throw error;
    }
  };

  router.get("/v1/knowledge", async (_request, response) => {
    const knowledgeExports = await knowledge();
    const view: KnowledgeView = {
      running: knowledgeExports.busy(),
      reviews: knowledgeExports.reviews(10),
      proposals: knowledgeExports.proposals(),
      finders: await knowledgeExports.finders(),
    };
    response.json(view);
  });
  router.post("/v1/knowledge/review", async (_request, response) => {
    const knowledgeExports = await knowledge();
    if (knowledgeExports.busy()) throw invalid("a knowledge review is already running");
    // One review-model call and a few Jev calls: it continues in the background and shows in GET /v1/knowledge.
    void knowledgeExports
      .review("user")
      .catch((error) => hub.log.warn("knowledge.review_failed", { error: String(error) }));
    response.status(202).json({ started: true });
  });
  router.post("/v1/knowledge/proposals/:id/approve", async (request, response) => {
    const id = int(request.params.id, "id", 0);
    response.json(await guard(async () => (await knowledge()).approve(id)));
  });
  router.post("/v1/knowledge/proposals/:id/reject", async (request, response) => {
    const id = int(request.params.id, "id", 0);
    const reason = request.body?.reason;
    if (reason !== undefined && typeof reason !== "string") throw invalid("reason must be text");
    response.json(await guard(async () => (await knowledge()).reject(id, reason)));
  });
  router.post("/v1/knowledge/proposals/:id/undo", async (request, response) => {
    const id = int(request.params.id, "id", 0);
    response.json(await guard(async () => (await knowledge()).undo(id)));
  });
  return router;
}
