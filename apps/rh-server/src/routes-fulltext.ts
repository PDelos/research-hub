// The full-text API (spec full-text: Full-text API): a paper's full text, fetching it now, and the converters.
import express, { type Router } from "express";
import type { ConverterInfo, FullTextView } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { FullTextInvalid, type FullText, type FullTextExports } from "../plugins/rh.fulltext/main.ts";

const view = (paperId: number, t: FullText | undefined): FullTextView =>
  t ?? { paperId, status: "none", source: null, sections: [], chars: 0, notes: [], fetchedAt: null };

export function fullTextRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const fulltext = () => hub.project.plugins.exportsOf<FullTextExports>("rh.fulltext");
  const paper = (raw: unknown) => {
    const id = int(raw, "id");
    if (!hub.project.papers.store.get(id)) throw notFound(`No paper ${id}`);
    return id;
  };

  router.get("/v1/papers/:id/fulltext", async (request, response) => {
    const id = paper(request.params.id);
    response.json(view(id, (await fulltext()).get(id)));
  });
  router.post("/v1/papers/:id/fulltext", async (request, response) => {
    const id = paper(request.params.id);
    try {
      response.json(view(id, await (await fulltext()).refetch(id)));
    } catch (error) {
      if (error instanceof FullTextInvalid) throw invalid(error.message);
      throw error;
    }
  });
  router.get("/v1/fulltext/converters", async (_request, response) => {
    const list: ConverterInfo[] = await (await fulltext()).converters();
    response.json(list);
  });
  return router;
}
