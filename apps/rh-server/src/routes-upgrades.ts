// The weekly upgrade API (spec weekly-upgrade): runs with their reports, proposals to approve or reject, add-on
// suggestions to dismiss, and starting a run now.
import express, { type Router } from "express";
import type { UpgradesView } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { FOCUSES, UpgradeInvalid, type Focus, type UpgradesExports } from "../plugins/rh.upgrades/main.ts";

export function upgradeRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const upgrades = () => hub.project.plugins.exportsOf<UpgradesExports>("rh.upgrades");
  const guard = async <T>(fn: () => T | Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UpgradeInvalid) throw invalid(error.message);
      throw error;
    }
  };

  r.get("/v1/upgrades", async (_req, res) => {
    const u = await upgrades();
    const settings = hub.project.plugins.kernel.settings("rh.upgrades");
    const view: UpgradesView = {
      enabled: settings.enabled as boolean,
      everyDays: settings.everyDays as number,
      running: u.busy(),
      due: u.due(),
      runs: u.runs(20),
      proposals: u.proposals(),
      suggestions: u.suggestions(),
    };
    res.json(view);
  });
  r.post("/v1/upgrades/run", async (req, res) => {
    const focus = req.body?.focus as Focus | undefined;
    if (focus !== undefined && !FOCUSES.includes(focus)) throw invalid(`focus must be one of ${FOCUSES.join(", ")}`);
    const u = await upgrades();
    if (u.busy()) throw invalid("an upgrade is already running");
    // A run can take minutes (benchmarks); it continues in the background and shows in GET /v1/upgrades.
    void u
      .run({ ...(focus ? { focus } : {}), requestedBy: "user" })
      .catch((error) => hub.log.warn("upgrades.run_failed", { error: String(error) }));
    res.status(202).json({ started: true });
  });
  r.post("/v1/proposals/:id/approve", async (req, res) => {
    const id = int(req.params.id, "id", 0);
    res.json(await guard(async () => (await upgrades()).approve(id)));
  });
  r.post("/v1/proposals/:id/reject", async (req, res) => {
    const id = int(req.params.id, "id", 0);
    res.json(await guard(async () => (await upgrades()).reject(id)));
  });
  r.post("/v1/suggestions/:id/dismiss", async (req, res) => {
    const id = int(req.params.id, "id", 0);
    res.json(await guard(async () => (await upgrades()).dismiss(id)));
  });
  return r;
}
