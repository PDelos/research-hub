// The harness's tables: replays of past sweeps with a variant of the settings, and benchmark runs per slot.
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { Logger } from "../../src/logger.ts";
import type { ReplayReport, Variant } from "../../src/harness/replay.ts";
import type { Judge } from "./judge.ts";
import type { BenchmarkRecord, StoredReplay } from "./main.ts";

interface ReplayRow {
  id: number;
  variant_json: string;
  report_json: string;
  requested_by: string;
  created_at: string;
}

interface BenchmarkRow {
  id: number;
  slot: string;
  preset: string;
  candidate_json: string;
  result_json: string;
  cost_usd: number;
  created_at: string;
}

const toReplay = (r: ReplayRow): StoredReplay => ({
  id: Number(r.id),
  variant: JSON.parse(r.variant_json) as Variant,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  report: JSON.parse(r.report_json) as ReplayReport,
});

const toBenchmark = (r: BenchmarkRow): BenchmarkRecord => ({
  id: Number(r.id),
  slot: r.slot,
  preset: r.preset,
  candidate: JSON.parse(r.candidate_json),
  result: JSON.parse(r.result_json),
  costUsd: r.cost_usd,
  createdAt: r.created_at,
});

export class HarnessStore {
  private readonly replaysTable: string;
  private readonly benchmarksTable: string;

  constructor(
    rh: RhApi,
    private readonly db: Db,
    judge: Judge,
    private readonly log: Logger,
  ) {
    this.replaysTable = rh.db.table("replays");
    this.benchmarksTable = rh.db.table("benchmarks");
    rh.db.migrate([
      ...judge.migrations(),
      {
        version: 3,
        sql: `CREATE TABLE ${this.benchmarksTable} (id INTEGER PRIMARY KEY, slot TEXT NOT NULL, preset TEXT NOT NULL,
              candidate_json TEXT NOT NULL, result_json TEXT NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL)`,
      },
      {
        version: 2,
        sql: `CREATE TABLE ${this.replaysTable} (id INTEGER PRIMARY KEY, variant_json TEXT NOT NULL, report_json TEXT NOT NULL,
              verdict TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
      },
    ]);
  }

  replays(limit: number): StoredReplay[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.replaysTable} ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as ReplayRow[];
    return rows.map(toReplay);
  }

  addReplay(variant: Variant, report: ReplayReport, requestedBy: string): StoredReplay {
    const createdAt = new Date().toISOString();
    const written = this.db
      .prepare(
        `INSERT INTO ${this.replaysTable} (variant_json, report_json, verdict, requested_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(JSON.stringify(variant), JSON.stringify(report), report.verdict, requestedBy, createdAt);
    return { id: Number(written.lastInsertRowid), variant, requestedBy, createdAt, report };
  }

  benchmarks(slot: string | undefined, limit: number): BenchmarkRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.benchmarksTable} ${slot ? "WHERE slot = ?" : ""} ORDER BY id DESC LIMIT ?`)
      .all(...(slot ? [slot, limit] : [limit])) as unknown as BenchmarkRow[];
    return rows.map(toBenchmark);
  }

  /** Store a benchmark run (the slot's preset is the slot's id). */
  record(run: Omit<BenchmarkRecord, "id" | "createdAt" | "preset">): BenchmarkRecord {
    const createdAt = new Date().toISOString();
    const { slot, candidate, result, costUsd } = run;
    const inserted = this.db
      .prepare(
        `INSERT INTO ${this.benchmarksTable} (slot, preset, candidate_json, result_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(slot, slot, JSON.stringify(candidate), JSON.stringify(result), costUsd, createdAt);
    this.log.info("harness.benchmark", { slot, candidate, value: result.value, costUsd });
    return { id: Number(inserted.lastInsertRowid), slot, preset: slot, candidate, result, costUsd, createdAt };
  }
}
