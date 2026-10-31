// The slot catalog as the Upgrades tab shows it: what is active in each slot, the alternatives, and the last
// benchmark (for ranking, the last replay).
import type { BuiltinHost } from "../../src/kernel/builtin.ts";
import { SLOTS } from "../../src/harness/slots.ts";
import type { SweepExports } from "../rh.sweep/main.ts";
import type { Judge } from "./judge.ts";
import type { BenchmarkRecord, SlotView, StoredReplay } from "./main.ts";
import type { HarnessStore } from "./store.ts";

function activeConverter(host: BuiltinHost): SlotView["active"] {
  const converter = host.services.contributions.activeContribution(
    "fulltext.converter",
    host.settingsOf("rh.fulltext"),
  );
  return {
    name: String(converter?.title ?? "none"),
    pluginId: converter?.pluginId ?? "rh.converter-pdf",
    detail: { converter: converter?.id },
  };
}

/** What runs in each slot now. */
function activeBySlot(host: BuiltinHost, sweep: SweepExports, judge: Judge): Record<string, SlotView["active"]> {
  const { options } = host;
  return {
    ranking: { name: "Rank formula and Jev gates", pluginId: "rh.sweep", detail: { ...sweep.currentSettings() } },
    embedder: {
      name: `${options.papers.embedModel} (${options.papers.embedDims} dimensions)`,
      pluginId: "rh.embedder-openrouter",
      detail: { model: options.papers.embedModel, dims: options.papers.embedDims },
    },
    facets: { name: "Jev abstract-facets", pluginId: "rh.papers" },
    converter: activeConverter(host),
    judge: { name: "Jev would-like", pluginId: "rh.harness", detail: { ...judge.latestCalibration() } },
    "kb-search": { name: "SQLite full-text search", pluginId: "rh.kb" },
    models: {
      name: "OpenRouter models per job",
      pluginId: "rh.provider-openrouter",
      detail: { ...options.catalog.jobs },
    },
  };
}

/** A replay shown as the ranking slot's benchmark. */
function replayAsBenchmark(replay: StoredReplay): BenchmarkRecord {
  return {
    id: replay.id,
    slot: "ranking",
    preset: "ranking",
    candidate: replay.variant as Record<string, unknown>,
    result: {
      tasks: [
        {
          task: "replay",
          metric: "held-out nDCG difference",
          value: replay.report.heldOut.diff,
          items: replay.report.sweeps.labelled,
        },
      ],
      value: replay.report.heldOut.diff,
      label: replay.report.verdict,
    },
    costUsd: 0,
    createdAt: replay.createdAt,
  };
}

export function slotViews(host: BuiltinHost, sweep: SweepExports, judge: Judge, store: HarnessStore): SlotView[] {
  const alternatives = (slot: string) =>
    host.services.contributions.slotPlugins(slot).map((p) => ({ pluginId: p.id, name: p.displayName }));
  const lastReplay = store.replays(1)[0];
  const active = activeBySlot(host, sweep, judge);
  return SLOTS.map((slot) => {
    const last =
      slot.id === "ranking" && lastReplay ? replayAsBenchmark(lastReplay) : (store.benchmarks(slot.id, 1)[0] ?? null);
    return {
      ...slot,
      active: active[slot.id],
      alternatives: alternatives(slot.id).filter((a) => a.pluginId !== active[slot.id].pluginId),
      last,
    };
  });
}
