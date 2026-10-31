// The weekly upgrade's tables: each run with its focus and report, the proposals it made, and add-on suggestions.
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { Focus, Proposal, Suggestion, UpgradeReport, UpgradeRun } from "./main.ts";

export class UpgradeInvalid extends Error {}

interface RunRow {
  id: number;
  focus: Focus;
  reason: string;
  status: UpgradeRun["status"];
  report_json: string | null;
  cost_usd: number;
  requested_by: string;
  started_at: string;
  finished_at: string | null;
}

interface ProposalRow {
  id: number;
  run_id: number;
  kind: Proposal["kind"];
  payload_json: string;
  status: Proposal["status"];
  commit_id: string | null;
  created_at: string;
  decided_at: string | null;
}

interface SuggestionRow {
  id: number;
  run_id: number;
  name: string;
  url: string;
  reason: string;
  status: Suggestion["status"];
  created_at: string;
}

const now = () => new Date().toISOString();

const toRun = (r: RunRow): UpgradeRun => ({
  id: Number(r.id),
  focus: r.focus,
  reason: r.reason,
  status: r.status,
  report: r.report_json ? (JSON.parse(r.report_json) as UpgradeReport) : null,
  costUsd: r.cost_usd,
  requestedBy: r.requested_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toProposal = (r: ProposalRow): Proposal => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  kind: r.kind,
  payload: JSON.parse(r.payload_json),
  status: r.status,
  commit: r.commit_id,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const toSuggestion = (r: SuggestionRow): Suggestion => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  name: r.name,
  url: r.url,
  reason: r.reason,
  status: r.status,
  createdAt: r.created_at,
});

export class UpgradeStore {
  private readonly tables: { runs: string; proposals: string; suggestions: string };

  constructor(
    rh: RhApi,
    private readonly db: Db,
  ) {
    this.tables = {
      runs: rh.db.table("runs"),
      proposals: rh.db.table("proposals"),
      suggestions: rh.db.table("suggestions"),
    };
    const { runs, proposals, suggestions } = this.tables;
    rh.db.migrate([
      {
        version: 1,
        sql: `CREATE TABLE ${runs} (id INTEGER PRIMARY KEY, focus TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
              report_json TEXT, cost_usd REAL NOT NULL DEFAULT 0, requested_by TEXT NOT NULL, started_at TEXT NOT NULL,
              finished_at TEXT);
            CREATE TABLE ${proposals} (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, kind TEXT NOT NULL,
              payload_json TEXT NOT NULL, status TEXT NOT NULL, commit_id TEXT, created_at TEXT NOT NULL, decided_at TEXT);
            CREATE TABLE ${suggestions} (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, name TEXT NOT NULL,
              url TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)`,
      },
    ]);
    // A run interrupted by a restart did not finish.
    db.prepare(`UPDATE ${runs} SET status = 'failed', finished_at = ? WHERE status = 'running'`).run(now());
  }

  // --- Runs

  /** The last finished run (its focus and when it started). */
  lastDone(): { focus: Focus; started_at: string } | undefined {
    return this.db.prepare(`SELECT * FROM ${this.tables.runs} WHERE status = 'done' ORDER BY id DESC LIMIT 1`).get() as
      | RunRow
      | undefined;
  }

  /** When the last run that did not fail started. */
  lastStart(): string | undefined {
    const row = this.db
      .prepare(`SELECT started_at FROM ${this.tables.runs} WHERE status != 'failed' ORDER BY id DESC LIMIT 1`)
      .get() as { started_at: string } | undefined;
    return row?.started_at;
  }

  recentFoci(limit: number): string[] {
    const rows = this.db
      .prepare(`SELECT focus FROM ${this.tables.runs} WHERE status = 'done' ORDER BY id DESC LIMIT ?`)
      .all(limit) as { focus: string }[];
    return rows.map((r) => r.focus);
  }

  startRun(focus: Focus, reason: string, requestedBy: string, startedAt: string): number {
    const written = this.db
      .prepare(
        `INSERT INTO ${this.tables.runs} (focus, reason, status, requested_by, started_at) VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(focus, reason, requestedBy, startedAt);
    return Number(written.lastInsertRowid);
  }

  finishRun(id: number, status: UpgradeRun["status"], report: UpgradeReport, costUsd: number): UpgradeRun {
    this.db
      .prepare(`UPDATE ${this.tables.runs} SET status = ?, report_json = ?, cost_usd = ?, finished_at = ? WHERE id = ?`)
      .run(status, JSON.stringify(report), costUsd, now(), id);
    return toRun(this.db.prepare(`SELECT * FROM ${this.tables.runs} WHERE id = ?`).get(id) as unknown as RunRow);
  }

  runs(limit: number): UpgradeRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.tables.runs} ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as RunRow[];
    return rows.map(toRun);
  }

  // --- Proposals

  proposal(id: number): Proposal {
    const row = this.db.prepare(`SELECT * FROM ${this.tables.proposals} WHERE id = ?`).get(id) as
      | ProposalRow
      | undefined;
    if (!row) throw new UpgradeInvalid(`no proposal ${id}`);
    return toProposal(row);
  }

  proposals(status?: Proposal["status"]): Proposal[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.tables.proposals} ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 50`)
      .all(...(status ? [status] : [])) as unknown as ProposalRow[];
    return rows.map(toProposal);
  }

  /** A new proposal for the human to decide; one already `applied` records its settings commit. */
  addProposal(runId: number, kind: Proposal["kind"], payload: object, applied?: { commit: string | null }): Proposal {
    const status: Proposal["status"] = applied ? "applied" : "proposed";
    const written = this.db
      .prepare(
        `INSERT INTO ${this.tables.proposals} (run_id, kind, payload_json, status, commit_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, kind, JSON.stringify(payload), status, applied?.commit ?? null, now(), applied ? now() : null);
    return this.proposal(Number(written.lastInsertRowid));
  }

  decide(id: number, status: "approved" | "rejected", commit?: string | null): void {
    if (status === "approved")
      this.db
        .prepare(`UPDATE ${this.tables.proposals} SET status = 'approved', commit_id = ?, decided_at = ? WHERE id = ?`)
        .run(commit ?? null, now(), id);
    else
      this.db
        .prepare(`UPDATE ${this.tables.proposals} SET status = 'rejected', decided_at = ? WHERE id = ?`)
        .run(now(), id);
  }

  // --- Add-on suggestions

  suggestions(includeDismissed = false): Suggestion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.tables.suggestions} ${includeDismissed ? "" : "WHERE status = 'open'"} ORDER BY id DESC`,
      )
      .all() as unknown as SuggestionRow[];
    return rows.map(toSuggestion);
  }

  addSuggestion(runId: number, suggestion: { name: string; url: string; reason: string }): void {
    this.db
      .prepare(`INSERT INTO ${this.tables.suggestions} (run_id, name, url, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, suggestion.name, suggestion.url, suggestion.reason, now());
  }

  dismiss(id: number): Suggestion {
    const written = this.db.prepare(`UPDATE ${this.tables.suggestions} SET status = 'dismissed' WHERE id = ?`).run(id);
    if (!written.changes) throw new UpgradeInvalid(`no suggestion ${id}`);
    return toSuggestion(
      this.db.prepare(`SELECT * FROM ${this.tables.suggestions} WHERE id = ?`).get(id) as unknown as SuggestionRow,
    );
  }
}
