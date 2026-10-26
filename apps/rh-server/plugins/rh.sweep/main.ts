// Built-in plugin rh.sweep: paper decisions (Jev gates and scores, with taste examples from feedback), the sweep
// runner, the card store and the card writer agent. Requested sweeps start when the scheduler asks.
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { CardWriter } from "../../src/sweep/card-writer.ts";
import { CardStore } from "../../src/sweep/cards.ts";
import { PaperDecisions } from "../../src/sweep/decisions.ts";
import { SweepRunner, type RankWeights } from "../../src/sweep/sweep.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { DecisionExports } from "../rh.decision-jev/main.ts";
import type { FeedbackExports } from "../rh.feedback/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import type { ScheduleExports } from "../rh.schedule/main.ts";
import { migrateExploration, pickExploration } from "./exploration.ts";

export interface SweepExports extends AgentHooks {
  decisions: PaperDecisions;
  sweeps: SweepRunner;
  cards: CardStore;
  cardWriter: CardWriter;
}

export function activate(context: PluginContext): SweepExports {
  const host = hostOf(context);
  const { catalog } = context.exports["rh.provider-openrouter"] as ProviderExports;
  const jev = context.exports["rh.decision-jev"] as DecisionExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const { scheduler } = context.exports["rh.schedule"] as ScheduleExports;
  const { feedback, attachCards } = context.exports["rh.feedback"] as FeedbackExports;
  migrateExploration(context.rh);
  const decisions = new PaperDecisions({
    db: host.db,
    jevDir: jev.jevDir,
    decide: jev.decide,
    ledger: jev.ledger,
    taste: () =>
      feedback
        .recent(8)
        .map((j) => ({ title: j.title, verdict: j.verdict, ...(j.reason ? { reason: j.reason.slice(0, 200) } : {}) })),
  });
  const sweeps = new SweepRunner({
    db: host.db,
    settings: host.settings,
    charters,
    papers,
    decisions,
    log: host.log,
    judged: () => feedback.count(),
    judgedPaper: (paperId) => feedback.isJudged(paperId),
    weight: (kind, key, fallback) => feedback.weight(kind, key, fallback),
    // A value saved before v1-1 (settings table) counts until the plugin setting is changed.
    explore: ({ sweepId, ranked, slots }) =>
      pickExploration({
        db: host.db,
        vectors: papers.vectors,
        sweepId,
        ranked,
        slots,
        picks: context.settings.explorationPicks as number,
      }),
    knobs: () => ({
      relevanceMin: context.settings.relevanceMin as number | undefined,
      worthMin: context.settings.worthMin as number | undefined,
      rankWeights: context.settings.rankWeights as RankWeights | undefined,
    }),
    cardsPerSweep: () =>
      (context.savedSettings.cardsPerSweep as number | undefined) ??
      host.settings.get<number | undefined>("cards_per_sweep", undefined) ??
      (context.settings.cardsPerSweep as number),
  });
  // Settings are read when used, so a change applies without restarting the sweep.
  context.onSettingsChange(() => undefined);
  const cards = new CardStore(host.db);
  attachCards(cards);
  const cardWriter = new CardWriter({
    db: host.db,
    cards,
    runner: sweeps,
    papers,
    decisions,
    charters,
    catalog,
    promptsDir: host.options.promptsDir,
    log: host.log,
    observe: host.observe,
  });
  sweeps.setCardStage(cardWriter);
  const runSweeps = host.options.runSweeps !== false;
  context.subscriptions.push({
    dispose: scheduler.onRequested((run) => {
      if (run.kind === "sweep" && runSweeps) sweeps.pickUp();
    }),
  });
  return {
    decisions,
    sweeps,
    cards,
    cardWriter,
    separateExtensions: [cardWriter.extension],
    attach: (harness, ctx) => cardWriter.attach(harness, ctx),
    ready: () => {
      if (runSweeps) sweeps.pickUp();
    },
  };
}
