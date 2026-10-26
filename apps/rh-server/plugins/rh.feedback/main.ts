// Built-in plugin rh.feedback: judgments with reasons, the reason parser (Jev reason-parse) that turns them into
// weights, and the desk's recent_cards and judge_card tools. The card store comes from rh.sweep when it activates.
import { Feedback } from "../../src/feedback/feedback.ts";
import { ReasonParser } from "../../src/feedback/reasons.ts";
import { feedbackTools } from "../../src/feedback/tools.ts";
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { CardStore } from "../../src/sweep/cards.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { DecisionExports } from "../rh.decision-jev/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";

export interface FeedbackExports extends AgentHooks {
  feedback: Feedback;
  reasons: ReasonParser;
  /** rh.sweep hands over its card store (cards are judged here but written there). */
  attachCards(cards: CardStore): void;
}

export function activate(context: PluginContext): FeedbackExports {
  const host = hostOf(context);
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const jev = context.exports["rh.decision-jev"] as DecisionExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const feedback = new Feedback({ db: host.db, charters, log: host.log });
  feedback.replay();
  const reasons = new ReasonParser({
    db: host.db,
    jevDir: jev.jevDir,
    decide: jev.decide,
    ledger: jev.ledger,
    log: host.log,
  });
  // Classify reasons after each judgment (in the background; a Jev failure leaves them pending for the next one).
  context.subscriptions.push({ dispose: feedback.onChange(() => void reasons.parsePending()) });
  let cards: CardStore | undefined;
  const tools = feedbackTools(() => {
    if (!cards) throw new Error("the card store is not ready (rh.sweep is not active)");
    return { cards, feedback, store: papers.store };
  });
  return {
    feedback,
    reasons,
    attachCards: (store) => void (cards = store),
    agentExtensions: [tools],
    ready: () => void reasons.parsePending(),
  };
}
