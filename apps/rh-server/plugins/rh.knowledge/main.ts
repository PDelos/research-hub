// Built-in plugin rh.knowledge (spec knowledge-loop; design v1-5): the knowledge review. Before each weekly digest it
// turns what the user liked, disliked and wrote into charter proposals with evidence: weights the judgments moved,
// questions and queries that bring nothing, new research directions and out-of-scope topics (one review-model call,
// directions scored by Jev). Nothing changes until the user approves; an approved proposal becomes the next charter
// version, which the next sweep uses.
import type { Charter, Charters } from "../../src/charter.ts";
import { hostOf, type BuiltinHost } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { FeedbackExports } from "../rh.feedback/main.ts";
import type { KbExports } from "../rh.kb/main.ts";
import { SETTING_KINDS, applyChange, ChangeRefused, ChangeStale, type Change, type Evidence } from "./evidence.ts";
import { KnowledgeInvalid, ProposalStore } from "./proposals.ts";
import { Reviewer } from "./review.ts";

export { changeKey, KnowledgeInvalid } from "./proposals.ts";
export { jsonObject, REVIEW_MARKER } from "./review.ts";

export interface KnowledgeProposal {
  id: number;
  reviewId: number;
  kind: Change["kind"];
  change: Change;
  /** One line: "Retire Q3 (…)". */
  title: string;
  evidence: Evidence;
  status: "proposed" | "approved" | "rejected" | "stale" | "undone";
  /** For a new question: the finder it came from (or "interests"). */
  finder: string | null;
  baseVersion: number;
  appliedVersion: number | null;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface KnowledgeReview {
  id: number;
  requestedBy: string;
  report: {
    charterVersion: number | null;
    rules: number;
    directions: { question: string; score: number | null; kept: boolean; note?: string; finder?: string }[];
    outOfScope: { topic: string; kept: boolean; note?: string }[];
    /** What the question finders brought (v1-7). */
    leads?: { finder: string; summary: string }[];
    proposals: number[];
    notes: string[];
  };
  costUsd: number;
  createdAt: string;
}

/** A lead from a question finder (v1-7 D1): what it noticed and the papers behind it. */
export interface Lead {
  summary: string;
  paperIds: number[];
}

/** What a question-finder plugin exports (extension point knowledge.finder). */
export interface FinderExports {
  leads(context: { finder: string; charter: Charter; since: string; limit: number }): Promise<Lead[]>;
}

export interface FinderStats {
  finder: string;
  title: string;
  proposed: number;
  approved: number;
  rejected: number;
  liked: number;
}

export const INTERESTS = "interests";

export interface KnowledgeExports {
  review(requestedBy?: string): Promise<KnowledgeReview>;
  reviews(limit?: number): KnowledgeReview[];
  proposals(status?: KnowledgeProposal["status"]): KnowledgeProposal[];
  approve(id: number): Promise<KnowledgeProposal>;
  reject(id: number, reason?: string): KnowledgeProposal;
  undo(id: number): Promise<KnowledgeProposal>;
  busy(): boolean;
  /** What each question finder brought: proposals, approvals, rejections, liked cards of its questions. */
  finders(): Promise<FinderStats[]>;
}

/** After a charter change: weights replay onto the new version, the vault's charter page follows, listeners hear. */
function afterCharterChange(context: PluginContext, version: number): void {
  (context.exports["rh.feedback"] as FeedbackExports).feedback.replay();
  try {
    (context.exports["rh.kb"] as KbExports | undefined)?.syncVault();
  } catch (error) {
    context.log.warn("knowledge.vault_sync_failed", { error: String(error) });
  }
  context.rh.events.emit("charter.changed", { version });
}

/** Level and taste rules are sweep settings: one undoable plugin-state change. */
async function approveSetting(host: BuiltinHost, store: ProposalStore, id: number, change: Change): Promise<void> {
  const sweep = host.settingsOf("rh.sweep");
  const tasteRules = (sweep.tasteRules as string[] | undefined) ?? [];
  const update =
    change.kind === "level" ? { level: change.level!.to } : { tasteRules: [...tasteRules, change.rule!].slice(-10) };
  await host.configure("rh.sweep", update, `proposal:knowledge-${id}`);
  const commit = (await host.pluginHistory(1))[0]?.id ?? null;
  store.decide(id, "approved", { commit_id: commit });
  for (const cardId of change.kind === "taste-rule" ? (change.candidateIds ?? []) : [])
    host.db.prepare("UPDATE rule_candidates SET status = 'accepted' WHERE card_id = ?").run(cardId);
}

/** The charter with the change, or a KnowledgeInvalid (a stale proposal is marked stale). */
function changedCharter(store: ProposalStore, id: number, charter: Charter, change: Change): Charter {
  try {
    return applyChange(charter, change);
  } catch (error) {
    if (error instanceof ChangeRefused) throw new KnowledgeInvalid(error.message);
    if (!(error instanceof ChangeStale)) throw error;
    store.decide(id, "stale", { reason: error.message });
    throw new KnowledgeInvalid(`proposal ${id} is stale: ${error.message}`);
  }
}

/** Every other change becomes the next charter version. */
function approveCharterChange(context: PluginContext, store: ProposalStore, id: number, change: Change): void {
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const current = charters.approved();
  if (!current) throw new KnowledgeInvalid("there is no approved charter");
  const applied = charters.approveVersion(changedCharter(store, id, current.charter, change), "user");
  store.decide(id, "approved", { before_version: current.version, applied_version: applied.version });
  const added = change.kind === "add-question" && applied.charter.questions.find((q) => q.text === change.text);
  if (added) store.setQuestionId(id, added.id);
  context.log.info("knowledge.approved", { id, version: applied.version });
  afterCharterChange(context, applied.version!);
}

/** Undo an approved proposal: a settings change through the plugin history, a charter change while it is latest. */
async function undoProposal(context: PluginContext, store: ProposalStore, charters: Charters, id: number) {
  const row = store.row(id);
  if (row.status !== "approved") throw new KnowledgeInvalid(`proposal ${id} is ${row.status}`);
  if (row.commit_id) {
    await hostOf(context).undo(row.commit_id, "user");
    store.decide(id, "undone");
    return;
  }
  if (charters.approved()?.version !== row.applied_version)
    throw new KnowledgeInvalid("a later charter version exists; undo is only possible while this change is the latest");
  const before = charters.version(Number(row.before_version));
  if (!before) throw new KnowledgeInvalid(`charter version ${row.before_version} is missing`);
  const restored = charters.approveVersion(before.charter, "user");
  store.decide(id, "undone");
  afterCharterChange(context, restored.version!);
}

/** What each question finder brought: proposals, approvals, rejections, liked cards of its approved questions. */
async function finderStats(host: BuiltinHost, store: ProposalStore): Promise<FinderStats[]> {
  const titles = new Map<string, string>([[INTERESTS, "Your interests (judgments, reasons, comments)"]]);
  for (const c of await host.services.contributions.contributionsTo("knowledge.finder"))
    titles.set(c.id, String(c.title ?? c.id));
  const rows = store.finderRows();
  const liked = (questionId: string, since: string) =>
    Number(
      (
        host.db
          .prepare(
            "SELECT COUNT(*) n FROM cards c JOIN judgments j ON j.card_id = c.id WHERE c.matched_question = ? AND c.created_at >= ? AND j.verdict IN ('up', 'star')",
          )
          .get(questionId, since) as { n: number }
      ).n,
    );
  return [...new Set([...titles.keys(), ...rows.map((r) => r.finder)])].map((finder) => {
    const mine = rows.filter((r) => r.finder === finder);
    return {
      finder,
      title: titles.get(finder) ?? finder,
      proposed: mine.length,
      approved: mine.filter((r) => r.status === "approved").length,
      rejected: mine.filter((r) => r.status === "rejected").length,
      liked: mine
        .filter((r) => r.status === "approved" && r.question_id && r.decided_at)
        .reduce((n, r) => n + liked(r.question_id!, r.decided_at!), 0),
    };
  });
}

export function activate(context: PluginContext): KnowledgeExports {
  const host = hostOf(context);
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const store = new ProposalStore(context.rh, host.db, charters);
  const reviewer = new Reviewer(context, store);
  const open = (id: number) => {
    const row = store.row(id);
    if (row.status !== "proposed") throw new KnowledgeInvalid(`proposal ${id} is ${row.status}`);
    return row;
  };

  let running: Promise<KnowledgeReview> | undefined;
  return {
    busy: () => running !== undefined,
    async review(requestedBy = "user") {
      if (running) return running;
      running = reviewer.run(requestedBy, charters.approved());
      try {
        return await running;
      } finally {
        running = undefined;
      }
    },
    reviews: (limit = 10) => store.reviews(limit),
    proposals: (status) => store.proposals(status),
    async approve(id) {
      const change = JSON.parse(open(id).change_json) as Change;
      if (SETTING_KINDS.includes(change.kind)) {
        await approveSetting(host, store, id, change);
        context.log.info("knowledge.approved", { id, kind: change.kind });
      } else approveCharterChange(context, store, id, change);
      return store.proposal(id);
    },
    reject(id, reason) {
      open(id);
      store.decide(id, "rejected", { reason: reason?.trim().slice(0, 500) || null });
      return store.proposal(id);
    },
    async undo(id) {
      await undoProposal(context, store, charters, id);
      return store.proposal(id);
    },
    finders: () => finderStats(host, store),
  };
}
