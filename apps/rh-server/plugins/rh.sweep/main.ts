// Built-in plugin rh.sweep: paper decisions (Jev gates and scores, with taste examples from feedback), the sweep
// runner, the card store and the card writer agent. Requested sweeps start when the scheduler asks.
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { CardWriter } from "../../src/sweep/card-writer.ts";
import { CardStore } from "../../src/sweep/cards.ts";
import { PaperDecisions } from "../../src/sweep/decisions.ts";
import { DEFAULT_RANK_WEIGHTS, SweepRunner, type RankWeights, type TargetLevel } from "../../src/sweep/sweep.ts";
import { DEFAULT_SETTINGS, type SweepSettings, type Variant } from "../../src/harness/replay.ts";
import { SettingsInvalid, validateSettings } from "../../src/kernel/settings.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { DecisionExports } from "../rh.decision-jev/main.ts";
import type { FeedbackExports } from "../rh.feedback/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import type { ScheduleExports } from "../rh.schedule/main.ts";
import { migrateExploration, pickExploration } from "./exploration.ts";

export interface SweepExports extends AgentHooks {
  /** The settings the next sweep uses, defaults filled in (the harness replays against these). */
  currentSettings(): SweepSettings;
  /** Throw SettingsInvalid unless the variant is a valid change of these settings. */
  validateVariant(variant: Variant): void;
  decisions: PaperDecisions;
  sweeps: SweepRunner;
  cards: CardStore;
  cardWriter: CardWriter;
}

/** Jev decisions for papers, with the user's recent judgments and approved taste rules as context. */
function paperDecisions(context: PluginContext, jev: DecisionExports, feedback: FeedbackExports["feedback"]) {
  return new PaperDecisions({
    db: hostOf(context).db,
    jevDir: jev.jevDir,
    decide: jev.decide,
    ledger: jev.ledger,
    taste: () =>
      feedback
        .recent(8)
        .map((j) => ({ title: j.title, verdict: j.verdict, ...(j.reason ? { reason: j.reason.slice(0, 200) } : {}) })),
    rules: () => (context.settings.tasteRules as string[] | undefined) ?? [],
  });
}

/** The settings in effect: unset thresholds come from the Jev commands' policies. */
function sweepSettings(context: PluginContext, decisions: PaperDecisions, cardsPerSweep: number): SweepSettings {
  const policyOf = (command: "on-theme" | "worth-reading") =>
    decisions.command(command).policy as Record<string, number>;
  return {
    relevanceMin: (context.settings.relevanceMin as number | undefined) ?? policyOf("on-theme").relevance_min,
    worthMin: (context.settings.worthMin as number | undefined) ?? policyOf("worth-reading").worth_min,
    rankWeights: (context.settings.rankWeights as RankWeights | undefined) ?? DEFAULT_RANK_WEIGHTS,
    cardsPerSweep,
    explorationPicks: context.settings.explorationPicks as number,
    level: (context.settings.level as TargetLevel | undefined) ?? "auto",
  };
}

/** A replay variant may change only sweep settings, to values the manifest allows. */
function validateVariant(context: PluginContext, variant: Record<string, unknown>): void {
  const unknown = Object.keys(variant).filter((k) => !(k in DEFAULT_SETTINGS));
  if (unknown.length)
    throw new SettingsInvalid(
      context.id,
      unknown.map((k) => `${k}: not a sweep setting a replay can change`),
    );
  validateSettings(context.manifest, { ...context.settings, ...variant });
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
  const decisions = paperDecisions(context, jev, feedback);
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
      level: (context.settings.level as TargetLevel | undefined) ?? "auto",
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
    currentSettings: () => sweepSettings(context, decisions, sweeps.cardsPerSweep()),
    validateVariant: (variant) => validateVariant(context, variant),
    decisions,
    sweeps,
    cards,
    cardWriter,
    separateExtensions: [cardWriter.extension],
    attach: (harness, agentContext) => cardWriter.attach(harness, agentContext),
    ready: () => {
      if (runSweeps) sweeps.pickUp();
    },
  };
}
