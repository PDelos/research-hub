// The daily cycle API (spec daily-cycle): where the cycle stands, the weekly digests, and comments on them.
import express, { type Router } from "express";
import type { DigestSection } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { CommentInvalid, type DigestExports } from "../plugins/rh.digest/main.ts";

export function cycleRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const digest = () => hub.project.plugins.exportsOf<DigestExports>("rh.digest");

  r.get("/v1/cycle", async (_req, res) => void res.json((await digest()).cycle()));

  r.get("/v1/digests", async (req, res) => {
    res.json((await digest()).digests(Math.min(int(req.query.limit, "limit", 20), 200)));
  });

  r.get("/v1/digests/:id", async (req, res) => {
    const d = (await digest()).digest(int(req.params.id, "id"));
    if (!d) throw notFound(`No digest ${req.params.id}`);
    res.json(d);
  });

  r.post("/v1/digests/:id/comments", async (req, res) => {
    const id = int(req.params.id, "id");
    try {
      res.status(201).json((await digest()).comment(id, req.body?.section as DigestSection, req.body?.text));
    } catch (error) {
      if (error instanceof CommentInvalid)
        throw error.message.startsWith("No digest") ? notFound(error.message) : invalid(error.message);
      throw error;
    }
  });

  return r;
}
