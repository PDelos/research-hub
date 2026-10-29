// The user's judgments (spec paper-feedback; design D1–D3, D6–D8): 👎/👍/⭐ with an optional reason per card, weights
// replayed from the charter base so each current judgment counts exactly once, the ⭐ hand-off to the knowledge base,
// and precision@5 per sweep.
import type { Charters } from "../charter.ts";
import { nowIso, type Db } from "../db.ts";
import type { Logger } from "../logger.ts";

export type Verdict = "up" | "down" | "star";
export const VERDICTS: readonly Verdict[] = ["up", "down", "star"];
export const STEP: Record<Verdict, number> = { up: 0.1, star: 0.15, down: -0.15 };
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 2;
export const REASON_MAX = 1000;
export type WeightKind = "question" | "query" | "source";

export class JudgmentInvalid extends Error {}

export interface Judgment {
  cardId: number;
  paperId: number;
  verdict: Verdict;
  reason?: string;
  reasonKind?: string;
  ruleProbability?: number;
  ruleStatus: "none" | "candidate" | "unclassified" | "pending";
  createdAt: string;
  updatedAt: string;
}

export interface WeightEffect {
  kind: WeightKind;
  key: string;
  before: number;
  after: number;
}

export interface Weight {
  kind: WeightKind;
  key: string;
  base: number;
  value: number;
}

export interface Precision {
  sweepId: number;
  startedAt: string;
  top: number;
  judged: number;
  good: number;
  precision: number | null;
}

const clamp = (w: number) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(w * 1000) / 1000));

export class Feedback {
  private readonly listeners = new Set<(cardId: number) => void>();

  constructor(private readonly deps: { db: Db; charters: Charters; log: Logger }) {}

  onChange(listener: (cardId: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record (or replace) the judgment of a card; replays weights and updates the knowledge-base request. */
  judge(cardId: number, verdict: unknown, reason?: unknown): Judgment {
    if (!VERDICTS.includes(verdict as Verdict))
      throw new JudgmentInvalid(`verdict must be one of ${VERDICTS.join(", ")}`);
    if (reason !== undefined && reason !== null && typeof reason !== "string")
      throw new JudgmentInvalid("reason must be text");
    const text = typeof reason === "string" ? reason.trim() : "";
    if (text.length > REASON_MAX)
      throw new JudgmentInvalid(`reason has ${text.length} characters, at most ${REASON_MAX} allowed`);
    const card = this.deps.db.prepare("SELECT id, paper_id FROM cards WHERE id = ?").get(cardId) as
      | { id: number; paper_id: number }
      | undefined;
    if (!card) throw new JudgmentInvalid(`no card ${cardId}`);
    const previous = this.get(cardId);
    const now = nowIso();
    const reasonChanged = (previous?.reason ?? "") !== text;
    this.deps.db
      .prepare(
        `INSERT INTO judgments (card_id, paper_id, verdict, reason, rule_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (card_id) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, updated_at = excluded.updated_at,
           reason_kind = CASE WHEN ? THEN NULL ELSE reason_kind END,
           rule_probability = CASE WHEN ? THEN NULL ELSE rule_probability END,
           rule_status = CASE WHEN ? THEN excluded.rule_status ELSE rule_status END`,
      )
      .run(
        cardId,
        card.paper_id,
        verdict as string,
        text || null,
        text ? "pending" : "none",
        now,
        now,
        reasonChanged ? 1 : 0,
        reasonChanged ? 1 : 0,
        reasonChanged ? 1 : 0,
      );
    if (reasonChanged) this.deps.db.prepare("DELETE FROM rule_candidates WHERE card_id = ?").run(cardId);
    this.handOff(Number(card.paper_id), cardId, verdict as Verdict);
    this.replay();
    this.deps.log.info("feedback.judged", {
      cardId,
      verdict,
      reason: text ? `${text.length} chars` : undefined,
      previous: previous?.verdict,
    });
    for (const l of this.listeners) l(cardId);
    return this.get(cardId)!;
  }

  /** Remove a card's judgment (its weight effects disappear in the replay; a pending ⭐ request is cancelled). */
  clear(cardId: number): void {
    const previous = this.get(cardId);
    if (!previous) return;
    this.deps.db.prepare("DELETE FROM judgments WHERE card_id = ?").run(cardId);
    this.deps.db.prepare("DELETE FROM rule_candidates WHERE card_id = ?").run(cardId);
    this.handOff(previous.paperId, cardId, undefined);
    this.replay();
    for (const l of this.listeners) l(cardId);
  }

  get(cardId: number): Judgment | undefined {
    const row = this.deps.db.prepare("SELECT * FROM judgments WHERE card_id = ?").get(cardId) as
      | JudgmentRow
      | undefined;
    return row ? toJudgment(row) : undefined;
  }

  /** The most recent judgments first. */
  recent(limit = 8): (Judgment & { title: string })[] {
    return (
      this.deps.db
        .prepare(
          "SELECT j.*, p.title FROM judgments j JOIN papers p ON p.id = j.paper_id ORDER BY j.updated_at DESC, j.card_id DESC LIMIT ?",
        )
        .all(limit) as unknown as (JudgmentRow & { title: string })[]
    ).map((r) => ({ ...toJudgment(r), title: r.title }));
  }

  count(): number {
    return Number((this.deps.db.prepare("SELECT COUNT(*) n FROM judgments").get() as { n: number }).n);
  }

  isJudged(paperId: number): boolean {
    return !!this.deps.db.prepare("SELECT 1 FROM judgments WHERE paper_id = ?").get(paperId);
  }

  // ---- ⭐ hand-off (D7)

  private handOff(paperId: number, cardId: number, verdict: Verdict | undefined): void {
    const now = nowIso();
    if (verdict === "star")
      this.deps.db
        .prepare(
          `INSERT INTO kb_requests (paper_id, card_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)
           ON CONFLICT (paper_id) DO UPDATE SET status = CASE WHEN status = 'cancelled' THEN 'pending' ELSE status END, updated_at = excluded.updated_at`,
        )
        .run(paperId, cardId, now, now);
    else
      this.deps.db
        .prepare(
          "UPDATE kb_requests SET status = 'cancelled', updated_at = ? WHERE paper_id = ? AND status = 'pending'",
        )
        .run(now, paperId);
  }

  kbRequests(
    status?: "pending" | "cancelled" | "done",
  ): { paperId: number; cardId: number; status: string; createdAt: string; updatedAt: string }[] {
    const rows = (
      status
        ? this.deps.db.prepare("SELECT * FROM kb_requests WHERE status = ? ORDER BY created_at").all(status)
        : this.deps.db.prepare("SELECT * FROM kb_requests ORDER BY created_at").all()
    ) as { paper_id: number; card_id: number; status: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({
      paperId: Number(r.paper_id),
      cardId: Number(r.card_id),
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // ---- weights (D2)

  /** Recompute effective weights from the approved charter by replaying current judgments in time order. */
  replay(): void {
    const db = this.deps.db;
    const charter = this.deps.charters.approved()?.charter;
    const weights = new Map<string, { kind: WeightKind; key: string; base: number; value: number }>();
    const id = (kind: WeightKind, key: string) => `${kind}\u0000${key}`;
    for (const q of charter?.questions ?? [])
      weights.set(id("question", q.id), { kind: "question", key: q.id, base: q.weight, value: q.weight });
    for (const q of charter?.queries ?? [])
      weights.set(id("query", q.text), { kind: "query", key: q.text, base: q.weight, value: q.weight });
    const judgments = db
      .prepare(
        `SELECT j.card_id, j.paper_id, j.verdict, c.matched_question, c.sweep_id FROM judgments j JOIN cards c ON c.id = j.card_id
         ORDER BY j.updated_at, j.card_id`,
      )
      .all() as {
      card_id: number;
      paper_id: number;
      verdict: Verdict;
      matched_question: string | null;
      sweep_id: number;
    }[];
    const effects: { cardId: number; kind: WeightKind; key: string; before: number; after: number }[] = [];
    for (const j of judgments) {
      const targets: [WeightKind, string][] = [];
      if (j.matched_question && weights.has(id("question", j.matched_question)))
        targets.push(["question", j.matched_question]);
      const found = db
        .prepare("SELECT queries_json FROM sweep_papers WHERE sweep_id = ? AND paper_id = ?")
        .get(j.sweep_id, j.paper_id) as { queries_json: string | null } | undefined;
      for (const q of found?.queries_json ? (JSON.parse(found.queries_json) as string[]) : [])
        if (weights.has(id("query", q))) targets.push(["query", q]);
      for (const { source } of db
        .prepare("SELECT source FROM paper_sources WHERE paper_id = ? ORDER BY source")
        .all(j.paper_id) as { source: string }[]) {
        if (!weights.has(id("source", source)))
          weights.set(id("source", source), { kind: "source", key: source, base: 1, value: 1 });
        targets.push(["source", source]);
      }
      for (const [kind, key] of targets) {
        const w = weights.get(id(kind, key))!;
        const before = w.value;
        w.value = clamp(before + STEP[j.verdict]);
        effects.push({ cardId: Number(j.card_id), kind, key, before, after: w.value });
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM weights; DELETE FROM weight_effects;");
      const insertWeight = db.prepare("INSERT INTO weights (kind, key, base, value) VALUES (?, ?, ?, ?)");
      for (const w of weights.values()) insertWeight.run(w.kind, w.key, w.base, w.value);
      const insertEffect = db.prepare(
        "INSERT INTO weight_effects (card_id, kind, key, before, after) VALUES (?, ?, ?, ?, ?)",
      );
      for (const e of effects) insertEffect.run(e.cardId, e.kind, e.key, e.before, e.after);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Effective weight, or `fallback` (the charter weight; 1 for a source) when nothing changed it. */
  weight(kind: WeightKind, key: string, fallback: number): number {
    const row = this.deps.db.prepare("SELECT value FROM weights WHERE kind = ? AND key = ?").get(kind, key) as
      | { value: number }
      | undefined;
    return row ? Number(row.value) : fallback;
  }

  weights(): Weight[] {
    return (
      this.deps.db.prepare("SELECT kind, key, base, value FROM weights ORDER BY kind, key").all() as unknown as Weight[]
    ).map((w) => ({
      kind: w.kind,
      key: w.key,
      base: Number(w.base),
      value: Number(w.value),
    }));
  }

  effects(cardId: number): WeightEffect[] {
    return (
      this.deps.db
        .prepare("SELECT kind, key, before, after FROM weight_effects WHERE card_id = ? ORDER BY rowid")
        .all(cardId) as unknown as WeightEffect[]
    ).map((e) => ({ kind: e.kind, key: e.key, before: Number(e.before), after: Number(e.after) }));
  }

  // ---- precision@5 (D8)

  precision(limit = 30): Precision[] {
    const sweeps = this.deps.db
      .prepare(
        "SELECT DISTINCT s.id, s.started_at FROM sweeps s JOIN cards c ON c.sweep_id = s.id ORDER BY s.id DESC LIMIT ?",
      )
      .all(limit) as { id: number; started_at: string }[];
    return sweeps.map((s) => {
      const top = this.deps.db
        .prepare(
          "SELECT c.id, j.verdict FROM cards c LEFT JOIN judgments j ON j.card_id = c.id WHERE c.sweep_id = ? ORDER BY c.rank IS NULL, c.rank, c.id LIMIT 5",
        )
        .all(s.id) as { id: number; verdict: Verdict | null }[];
      const judged = top.filter((t) => t.verdict).length;
      const good = top.filter((t) => t.verdict === "up" || t.verdict === "star").length;
      return {
        sweepId: Number(s.id),
        startedAt: s.started_at,
        top: top.length,
        judged,
        good,
        precision: judged ? good / judged : null,
      };
    });
  }
}

interface JudgmentRow {
  card_id: number;
  paper_id: number;
  verdict: Verdict;
  reason: string | null;
  reason_kind: string | null;
  rule_probability: number | null;
  rule_status: Judgment["ruleStatus"];
  created_at: string;
  updated_at: string;
}

function toJudgment(judgmentRow: JudgmentRow): Judgment {
  return {
    cardId: Number(judgmentRow.card_id),
    paperId: Number(judgmentRow.paper_id),
    verdict: judgmentRow.verdict,
    reason: judgmentRow.reason ?? undefined,
    reasonKind: judgmentRow.reason_kind ?? undefined,
    ruleProbability: judgmentRow.rule_probability ?? undefined,
    ruleStatus: judgmentRow.rule_status,
    createdAt: judgmentRow.created_at,
    updatedAt: judgmentRow.updated_at,
  };
}
