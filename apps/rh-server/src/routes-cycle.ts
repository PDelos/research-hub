// The daily cycle API (spec daily-cycle): where the cycle stands, the weekly digests, and comments on them.
import express, { type Router } from "express";
import type { DigestSection } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { CommentInvalid, type DigestExports } from "../plugins/rh.digest/main.ts";

export function cycleRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const digest = () => hub.project.plugins.exportsOf<DigestExports>("rh.digest");

  router.get("/v1/cycle", async (_request, response) => void response.json((await digest()).cycle()));

  router.get("/v1/digests", async (request, response) => {
    response.json((await digest()).digests(Math.min(int(request.query.limit, "limit", 20), 200)));
  });

  router.get("/v1/digests/:id", async (request, response) => {
    const view = (await digest()).digest(int(request.params.id, "id"));
    if (!view) throw notFound(`No digest ${request.params.id}`);
    response.json(view);
  });

  router.post("/v1/digests/:id/comments", async (request, response) => {
    const id = int(request.params.id, "id");
    try {
      response
        .status(201)
        .json((await digest()).comment(id, request.body?.section as DigestSection, request.body?.text));
    } catch (error) {
      if (error instanceof CommentInvalid)
        throw error.message.startsWith("No digest") ? notFound(error.message) : invalid(error.message);
      throw error;
    }
  });

  return router;
}
