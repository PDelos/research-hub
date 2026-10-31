// The knowledge review's tables: each review with its report and cost, and the charter proposals it made. A new
// review refreshes an open proposal with the same change instead of adding another, and a change the user rejected
// is not proposed again for REJECTED_MEMORY_DAYS.
import type { Charters } from "../../src/charter.ts";
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import { describeChange, type Change, type Proposed } from "./evidence.ts";
import type { KnowledgeProposal, KnowledgeReview } from "./main.ts";

export const REJECTED_MEMORY_DAYS = 90;

export class KnowledgeInvalid extends Error {}

export interface ProposalRow {
  id: number;
  review_id: number;
  kind: Change["kind"];
  change_json: string;
  evidence_json: string;
  status: KnowledgeProposal["status"];
  base_version: number;
  applied_version: number | null;
  before_version: number | null;
  reason: string | null;
  finder: string | null;
  question_id: string | null;
  commit_id: string | null;
  created_at: string;
  decided_at: string | null;
}

interface ReviewRow {
  id: number;
  requested_by: string;
  report_json: string;
  cost_usd: number;
  created_at: string;
}

const now = () => new Date().toISOString();

/** The proposal's identity: a new review refreshes an open proposal with the same key instead of adding another. */
export function changeKey(change: Change): string {
  return [
    change.kind,
    change.targetKind ?? "",
    (change.target ?? change.text ?? change.topic ?? "").toLowerCase(),
  ].join("|");
}

const toReview = (r: ReviewRow): KnowledgeReview => ({
  id: Number(r.id),
  requestedBy: r.requested_by,
  report: JSON.parse(r.report_json),
  costUsd: r.cost_usd,
  createdAt: r.created_at,
});

export class ProposalStore {
  private readonly tables: { reviews: string; proposals: string };

  constructor(
    rh: RhApi,
    private readonly db: Db,
    private readonly charters: Charters,
  ) {
    this.tables = { reviews: rh.db.table("reviews"), proposals: rh.db.table("proposals") };
    const { reviews, proposals } = this.tables;
    rh.db.migrate([
      {
        version: 1,
        sql: `CREATE TABLE ${reviews} (id INTEGER PRIMARY KEY, requested_by TEXT NOT NULL, report_json TEXT NOT NULL,
              cost_usd REAL NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE ${proposals} (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, kind TEXT NOT NULL,
              change_key TEXT NOT NULL, change_json TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL,
              base_version INTEGER NOT NULL, before_version INTEGER, applied_version INTEGER, reason TEXT,
              created_at TEXT NOT NULL, decided_at TEXT)`,
      },
      {
        version: 2,
        sql: `ALTER TABLE ${proposals} ADD COLUMN finder TEXT;
            ALTER TABLE ${proposals} ADD COLUMN question_id TEXT;
            ALTER TABLE ${proposals} ADD COLUMN commit_id TEXT`,
      },
    ]);
  }

  toProposal(row: ProposalRow): KnowledgeProposal {
    const change = JSON.parse(row.change_json) as Change;
    return {
      id: Number(row.id),
      reviewId: Number(row.review_id),
      kind: row.kind,
      change,
      title: describeChange(change, this.charters.version(Number(row.base_version))?.charter),
      evidence: JSON.parse(row.evidence_json),
      status: row.status,
      finder: row.finder,
      baseVersion: Number(row.base_version),
      appliedVersion: row.applied_version === null ? null : Number(row.applied_version),
      reason: row.reason,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
  }

  row(id: number): ProposalRow {
    const row = this.db.prepare(`SELECT * FROM ${this.tables.proposals} WHERE id = ?`).get(id) as
      | ProposalRow
      | undefined;
    if (!row) throw new KnowledgeInvalid(`no proposal ${id}`);
    return row;
  }

  proposal(id: number): KnowledgeProposal {
    return this.toProposal(this.row(id));
  }

  proposals(status?: KnowledgeProposal["status"]): KnowledgeProposal[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.tables.proposals} ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 100`)
      .all(...(status ? [status] : [])) as unknown as ProposalRow[];
    return rows.map((row) => this.toProposal(row));
  }

  /** Record a decision: the new status and any of the proposal's decision fields. */
  decide(
    id: number,
    status: KnowledgeProposal["status"],
    fields: Partial<Pick<ProposalRow, "reason" | "commit_id" | "before_version" | "applied_version">> = {},
  ): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    this.db
      .prepare(
        `UPDATE ${this.tables.proposals} SET status = ?, ${keys.map((k) => `${k} = ?, `).join("")}decided_at = ? WHERE id = ?`,
      )
      .run(status, ...keys.map((k) => fields[k] ?? null), now(), id);
  }

  setQuestionId(id: number, questionId: string): void {
    this.db.prepare(`UPDATE ${this.tables.proposals} SET question_id = ? WHERE id = ?`).run(questionId, id);
  }

  /** Keep a proposal of a review: refresh the open one with the same change, or add it; undefined when rejected lately. */
  keep(reviewId: number, baseVersion: number, proposed: Proposed): number | undefined {
    const { proposals } = this.tables;
    const key = changeKey(proposed.change);
    const since = new Date(Date.now() - REJECTED_MEMORY_DAYS * 86_400_000).toISOString();
    const rejected = this.db
      .prepare(`SELECT 1 FROM ${proposals} WHERE change_key = ? AND status = 'rejected' AND decided_at >= ?`)
      .get(key, since);
    if (rejected) return undefined;
    const open = this.db
      .prepare(`SELECT id FROM ${proposals} WHERE change_key = ? AND status = 'proposed'`)
      .get(key) as { id: number } | undefined;
    const change = JSON.stringify(proposed.change);
    const evidence = JSON.stringify(proposed.evidence);
    const finder = proposed.finder ?? null;
    if (open) {
      this.db
        .prepare(
          `UPDATE ${proposals} SET review_id = ?, change_json = ?, evidence_json = ?, base_version = ?, finder = ? WHERE id = ?`,
        )
        .run(reviewId, change, evidence, baseVersion, finder, open.id);
      return Number(open.id);
    }
    const written = this.db
      .prepare(
        `INSERT INTO ${proposals} (review_id, kind, change_key, change_json, evidence_json, status, base_version, finder, created_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .run(reviewId, proposed.change.kind, key, change, evidence, baseVersion, finder, now());
    return Number(written.lastInsertRowid);
  }

  /** The new questions each finder proposed, with what became of them. */
  finderRows() {
    return this.db
      .prepare(
        `SELECT finder, status, question_id, decided_at FROM ${this.tables.proposals} WHERE kind = 'add-question' AND finder IS NOT NULL`,
      )
      .all() as { finder: string; status: string; question_id: string | null; decided_at: string | null }[];
  }

  /** A review row, filled in when the review finishes; returns its id. */
  startReview(requestedBy: string): number {
    const written = this.db
      .prepare(
        `INSERT INTO ${this.tables.reviews} (requested_by, report_json, cost_usd, created_at) VALUES (?, '{}', 0, ?)`,
      )
      .run(requestedBy, now());
    return Number(written.lastInsertRowid);
  }

  finishReview(id: number, report: KnowledgeReview["report"], costUsd: number): KnowledgeReview {
    this.db
      .prepare(`UPDATE ${this.tables.reviews} SET report_json = ?, cost_usd = ? WHERE id = ?`)
      .run(JSON.stringify(report), costUsd, id);
    return toReview(
      this.db.prepare(`SELECT * FROM ${this.tables.reviews} WHERE id = ?`).get(id) as unknown as ReviewRow,
    );
  }

  reviews(limit: number): KnowledgeReview[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.tables.reviews} ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as ReviewRow[];
    return rows.map(toReview);
  }
}
