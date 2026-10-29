// The knowledge review's evidence rules (spec knowledge-loop: Charter changes from evidence; design v1-5 D2): charter
// changes that follow from the user's judgments without a model call, each with the evidence behind it.
import type { Charter } from "../../src/charter.ts";
import type { Db } from "../../src/db.ts";

export type ChangeKind =
  | "weight"
  | "retire-question"
  | "drop-query"
  | "add-question"
  | "add-out-of-scope"
  | "level"
  | "taste-rule";

/** Kinds that change the sweep's settings (v1-7), not the charter. */
export const SETTING_KINDS: readonly ChangeKind[] = ["level", "taste-rule"];

export interface Change {
  kind: ChangeKind;
  /** question id or query text (weight, retire-question, drop-query). */
  target?: string;
  targetKind?: "question" | "query";
  from?: number;
  to?: number;
  text?: string;
  queries?: string[];
  topic?: string;
  /** level: the level now and the one proposed. */
  level?: { from: string; to: string };
  /** taste-rule: the rule and the rule candidates (card ids) it generalizes. */
  rule?: string;
  candidateIds?: number[];
}

export interface Evidence {
  summary: string;
  papers: { id: number; title: string; verdict: string | null; reason?: string | null }[];
  comments?: string[];
  score?: number;
}

export interface Proposed {
  change: Change;
  evidence: Evidence;
  /** The question finder a new question came from (v1-7), or "interests". */
  finder?: string;
}

const LEVELS = ["foundational", "core", "advanced", "frontier"] as const;

/**
 * Level up (v1-7 D4): most liked cards in the window are above the current level (8+ liked, 60 %), or "too basic"
 * dislikes (3+) outnumber "too advanced" ones. "auto" counts as core.
 */
export function levelRule(db: Db, current: string, sinceIso: string): Proposed | undefined {
  const now = current === "auto" ? "core" : current;
  const i = LEVELS.indexOf(now as (typeof LEVELS)[number]);
  if (i < 0 || i >= LEVELS.length - 1) return undefined;
  const next = LEVELS[i + 1];
  const rows = db
    .prepare(
      `SELECT p.id, p.title, c.level, j.verdict, j.reason, j.reason_kind FROM judgments j JOIN cards c ON c.id = j.card_id
         JOIN papers p ON p.id = j.paper_id WHERE j.updated_at >= ? ORDER BY j.updated_at DESC`,
    )
    .all(sinceIso) as {
    id: number;
    title: string;
    level: string;
    verdict: string;
    reason: string | null;
    reason_kind: string | null;
  }[];
  const liked = rows.filter((r) => liked0(r.verdict));
  const above = liked.filter((r) => LEVELS.indexOf(r.level as (typeof LEVELS)[number]) > i);
  const tooBasic = rows.filter((r) => r.verdict === "down" && r.reason_kind === "too-basic");
  const tooAdvanced = rows.filter((r) => r.verdict === "down" && r.reason_kind === "too-advanced");
  const byLiked = liked.length >= 8 && above.length / liked.length >= 0.6;
  const byReasons = tooBasic.length >= 3 && tooBasic.length > tooAdvanced.length;
  if (!byLiked && !byReasons) return undefined;
  const papers = (byLiked ? above : tooBasic)
    .slice(0, 5)
    .map((r) => ({ id: Number(r.id), title: r.title, verdict: r.verdict, reason: r.reason }));
  return {
    change: { kind: "level", level: { from: current, to: next } },
    evidence: {
      summary: byLiked
        ? `${above.length} of the ${liked.length} cards you liked in the window are above ${now} (${[...new Set(above.map((a) => a.level))].join(", ")}).`
        : `You marked ${tooBasic.length} cards “too basic” and ${tooAdvanced.length} “too advanced”.`,
      papers,
    },
  };
}
const liked0 = (v: string | null) => v === "up" || v === "star";

export const WEIGHT_DRIFT = 0.25;
export const RETIRE_MIN_CARDS = 8;
export const DROP_MIN_CARDS = 10;

const liked = (v: string | null) => v === "up" || v === "star";
const round = (x: number) => Math.min(2, Math.max(0.1, Math.round(x * 20) / 20));

export function evidenceRules(db: Db, charter: Charter, sinceIso: string): Proposed[] {
  const out: Proposed[] = [];
  // Weights the user's judgments moved away from the charter's.
  const weights = db
    .prepare("SELECT kind, key, base, value FROM weights WHERE kind IN ('question', 'query')")
    .all() as {
    kind: "question" | "query";
    key: string;
    base: number;
    value: number;
  }[];
  for (const w of weights) {
    const exists =
      w.kind === "question"
        ? charter.questions.some((q) => q.id === w.key)
        : charter.queries.some((q) => q.text === w.key);
    if (!exists || Math.abs(w.value - w.base) < WEIGHT_DRIFT) continue;
    const to = round(w.value);
    if (to === w.base) continue;
    const label =
      w.kind === "question" ? `${w.key} (${charter.questions.find((q) => q.id === w.key)!.text})` : `“${w.key}”`;
    out.push({
      change: { kind: "weight", targetKind: w.kind, target: w.key, from: w.base, to },
      evidence: {
        summary: `Your judgments moved the weight of ${w.kind} ${label} from ${w.base} to ${w.value.toFixed(2)}; make it the charter's.`,
        papers: [],
      },
    });
  }
  // Per question: judged cards that matched it in the window.
  const cards = db
    .prepare(
      `SELECT c.matched_question q, p.id, p.title, j.verdict, j.reason, sp.queries_json
         FROM cards c JOIN papers p ON p.id = c.paper_id JOIN judgments j ON j.card_id = c.id
         LEFT JOIN sweep_papers sp ON sp.sweep_id = c.sweep_id AND sp.paper_id = c.paper_id
        WHERE c.created_at >= ? ORDER BY c.id DESC`,
    )
    .all(sinceIso) as {
    q: string | null;
    id: number;
    title: string;
    verdict: string;
    reason: string | null;
    queries_json: string | null;
  }[];
  const paper = (c: (typeof cards)[number]) => ({
    id: Number(c.id),
    title: c.title,
    verdict: c.verdict,
    reason: c.reason,
  });
  if (charter.questions.length > 3)
    for (const q of charter.questions) {
      const mine = cards.filter((c) => c.q === q.id);
      if (mine.length >= RETIRE_MIN_CARDS && !mine.some((c) => liked(c.verdict))) {
        out.push({
          change: { kind: "retire-question", target: q.id },
          evidence: {
            summary: `${q.id} (${q.text}) matched ${mine.length} cards you judged in the window and you liked none.`,
            papers: mine.slice(0, 5).map(paper),
          },
        });
        break; // One retirement per review: the next review sees the effect.
      }
    }
  if (charter.queries.length > 5)
    for (const query of charter.queries) {
      const mine = cards.filter((c) => (JSON.parse(c.queries_json ?? "[]") as string[]).includes(query.text));
      if (mine.length >= DROP_MIN_CARDS && !mine.some((c) => liked(c.verdict))) {
        out.push({
          change: { kind: "drop-query", target: query.text },
          evidence: {
            summary: `The query “${query.text}” found ${mine.length} papers that became cards you judged, and you liked none.`,
            papers: mine.slice(0, 5).map(paper),
          },
        });
        break;
      }
    }
  return out;
}

export class ChangeStale extends Error {}
export class ChangeRefused extends Error {}

/** The charter with one change applied (question ids kept); throws ChangeStale when its target is gone. */
export function applyChange(charter: Charter, change: Change): Charter {
  const c: Charter = structuredClone(charter);
  const question = (id?: string) => {
    const q = c.questions.find((x) => x.id === id);
    if (!q) throw new ChangeStale(`question ${id} is no longer in the charter`);
    return q;
  };
  const query = (text?: string) => {
    const q = c.queries.find((x) => x.text === text);
    if (!q) throw new ChangeStale(`the query “${text}” is no longer in the charter`);
    return q;
  };
  switch (change.kind) {
    case "weight":
      (change.targetKind === "question" ? question(change.target) : query(change.target)).weight = change.to!;
      break;
    case "retire-question":
      question(change.target);
      if (c.questions.length <= 3) throw new ChangeRefused("a charter keeps at least 3 questions");
      c.questions = c.questions.filter((q) => q.id !== change.target);
      break;
    case "drop-query":
      query(change.target);
      if (c.queries.length <= 5) throw new ChangeRefused("a charter keeps at least 5 queries");
      c.queries = c.queries.filter((q) => q.text !== change.target);
      break;
    case "add-question": {
      if (c.questions.length >= 7) throw new ChangeRefused("the charter has 7 questions: retire one first");
      c.questions.push({ text: change.text!, weight: 1 } as never);
      const have = new Set(c.queries.map((q) => q.text.toLowerCase()));
      for (const text of change.queries ?? [])
        if (c.queries.length < 20 && !have.has(text.toLowerCase())) c.queries.push({ text, weight: 1 });
      break;
    }
    case "level":
    case "taste-rule":
      throw new ChangeRefused(`${change.kind} changes the sweep's settings, not the charter`);
    case "add-out-of-scope":
      if (c.outOfScope.length >= 20) throw new ChangeRefused("the charter has 20 out-of-scope topics");
      if (!c.outOfScope.some((t) => t.toLowerCase() === change.topic!.toLowerCase())) c.outOfScope.push(change.topic!);
      break;
  }
  return c;
}

/** A short line for the change: "Retire Q3", "Add question: …". */
export function describeChange(change: Change, charter?: Charter): string {
  const qText = (id?: string) => charter?.questions.find((q) => q.id === id)?.text;
  switch (change.kind) {
    case "weight":
      return `Set the weight of ${change.targetKind} ${change.targetKind === "question" ? change.target : `“${change.target}”`} from ${change.from} to ${change.to}`;
    case "retire-question":
      return `Retire ${change.target}${qText(change.target) ? ` (${qText(change.target)})` : ""}`;
    case "drop-query":
      return `Drop the query “${change.target}”`;
    case "add-question":
      return `Add the question “${change.text}” with the queries ${(change.queries ?? []).map((q) => `“${q}”`).join(", ")}`;
    case "add-out-of-scope":
      return `Add “${change.topic}” to out of scope`;
    case "level":
      return `Raise your level from ${change.level?.from} to ${change.level?.to}`;
    case "taste-rule":
      return `Add the taste rule “${change.rule}”`;
  }
}
