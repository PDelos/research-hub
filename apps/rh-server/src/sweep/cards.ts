// Paper cards (spec paper-cards): at most one per paper per project (UNIQUE paper_id), with scores computed by code.
import { nowIso, type Db } from "../db.ts";
import type { CardScores, ScoreDetails } from "./scores.ts";

export interface Card {
  id: number;
  paperId: number;
  sweepId: number;
  rank?: number;
  summary: string;
  relevance: number;
  relevanceReason: string;
  trust: number;
  trustReason: string;
  value: number;
  valueReason: string;
  level: string;
  matchedQuestion?: string;
  borderline: boolean;
  details: ScoreDetails;
  createdAt: string;
}

export class CardStore {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly db: Db) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Create the paper's card, or return the existing one (a replayed call never makes a second card). */
  create(input: { paperId: number; sweepId: number; rank?: number; summary: string; scores: CardScores }): {
    card: Card;
    created: boolean;
  } {
    const cardScores = input.scores;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO cards (paper_id, sweep_id, rank, summary, relevance, relevance_reason, trust, trust_reason, value,
           value_reason, level, matched_question, borderline, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.paperId,
        input.sweepId,
        input.rank ?? null,
        input.summary,
        cardScores.relevance,
        cardScores.relevanceReason,
        cardScores.trust,
        cardScores.trustReason,
        cardScores.value,
        cardScores.valueReason,
        cardScores.level,
        cardScores.matchedQuestion ?? null,
        cardScores.borderline ? 1 : 0,
        JSON.stringify(cardScores.details),
        nowIso(),
      );
    const created = Number(result.changes) > 0;
    if (created) for (const l of this.listeners) l();
    return { card: this.byPaper(input.paperId)!, created };
  }

  get(id: number): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
    return row ? toCard(row) : undefined;
  }

  byPaper(paperId: number): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE paper_id = ?").get(paperId) as CardRow | undefined;
    return row ? toCard(row) : undefined;
  }

  /** Cards newest sweep first, in rank order within a sweep. */
  list(limit = 100): Card[] {
    return (
      this.db
        .prepare("SELECT * FROM cards ORDER BY sweep_id DESC, rank IS NULL, rank, id LIMIT ?")
        .all(limit) as unknown as CardRow[]
    ).map(toCard);
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM cards").get() as { n: number }).n);
  }
}

interface CardRow {
  id: number;
  paper_id: number;
  sweep_id: number;
  rank: number | null;
  summary: string;
  relevance: number;
  relevance_reason: string;
  trust: number;
  trust_reason: string;
  value: number;
  value_reason: string;
  level: string;
  matched_question: string | null;
  borderline: number;
  details_json: string;
  created_at: string;
}

function toCard(cardRow: CardRow): Card {
  return {
    id: Number(cardRow.id),
    paperId: Number(cardRow.paper_id),
    sweepId: Number(cardRow.sweep_id),
    rank: cardRow.rank === null ? undefined : Number(cardRow.rank),
    summary: cardRow.summary,
    relevance: Number(cardRow.relevance),
    relevanceReason: cardRow.relevance_reason,
    trust: Number(cardRow.trust),
    trustReason: cardRow.trust_reason,
    value: Number(cardRow.value),
    valueReason: cardRow.value_reason,
    level: cardRow.level,
    matchedQuestion: cardRow.matched_question ?? undefined,
    borderline: !!cardRow.borderline,
    details: JSON.parse(cardRow.details_json),
    createdAt: cardRow.created_at,
  };
}
