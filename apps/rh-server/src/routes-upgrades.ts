// The weekly upgrade API (spec weekly-upgrade): runs with their reports, proposals to approve or reject, add-on
// suggestions to dismiss, and starting a run now.
import express, { type Router } from "express";
import type { UpgradesView } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { FOCUSES, UpgradeInvalid, type Focus, type UpgradesExports } from "../plugins/rh.upgrades/main.ts";

export function upgradeRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const upgrades = () => hub.project.plugins.exportsOf<UpgradesExports>("rh.upgrades");
  const guard = async <T>(work: () => T | Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UpgradeInvalid) throw invalid(error.message);
      throw error;
    }
  };

  router.get("/v1/upgrades", async (_request, response) => {
    const upgradesExports = await upgrades();
    const settings = hub.project.plugins.kernel.settings("rh.upgrades");
    const view: UpgradesView = {
      enabled: settings.enabled as boolean,
      everyDays: settings.everyDays as number,
      running: upgradesExports.busy(),
      due: upgradesExports.due(),
      runs: upgradesExports.runs(20),
      proposals: upgradesExports.proposals(),
      suggestions: upgradesExports.suggestions(),
    };
    response.json(view);
  });
  router.post("/v1/upgrades/run", async (request, response) => {
    const focus = request.body?.focus as Focus | undefined;
    if (focus !== undefined && !FOCUSES.includes(focus)) throw invalid(`focus must be one of ${FOCUSES.join(", ")}`);
    const upgradesExports = await upgrades();
    if (upgradesExports.busy()) throw invalid("an upgrade is already running");
    // A run can take minutes (benchmarks); it continues in the background and shows in GET /v1/upgrades.
    void upgradesExports
      .run({ ...(focus ? { focus } : {}), requestedBy: "user" })
      .catch((error) => hub.log.warn("upgrades.run_failed", { error: String(error) }));
    response.status(202).json({ started: true });
  });
  router.post("/v1/proposals/:id/approve", async (request, response) => {
    const id = int(request.params.id, "id", 0);
    response.json(await guard(async () => (await upgrades()).approve(id)));
  });
  router.post("/v1/proposals/:id/reject", async (request, response) => {
    const id = int(request.params.id, "id", 0);
    response.json(await guard(async () => (await upgrades()).reject(id)));
  });
  router.post("/v1/suggestions/:id/dismiss", async (request, response) => {
    const id = int(request.params.id, "id", 0);
    response.json(await guard(async () => (await upgrades()).dismiss(id)));
  });
  return router;
}
