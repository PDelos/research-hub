// The weekly digest (spec daily-cycle: Weekly digest; design v1-1 D5): computed from the project's records, no LLM
// call. The period runs from the previous digest (or seven days back) to now.
import type { DigestBody } from "@rh/sdk";
import type { Db } from "../../src/db.ts";
import type { HistoryEntry } from "../../src/kernel/state.ts";
import { EXPLORATION_TABLE } from "../rh.sweep/exploration.ts";

const sum = (db: Db, sql: string, ...params: (string | number)[]) =>
  Number((db.prepare(sql).get(...params) as { c: number | null }).c ?? 0);

export function buildDigest(x: {
  db: Db;
  week: string;
  from: string;
  to: string;
  nightlyRuns: number;
  changes: HistoryEntry[];
  lastComments: DigestBody["lastComments"];
  precision: { sweepId: number; startedAt: string; judged: number; good: number; precision: number | null }[];
}): DigestBody {
  const { db, from, to } = x;
  const sweeps = (
    db
      .prepare(
        "SELECT s.id, s.status, s.started_at, (SELECT COUNT(*) FROM cards c WHERE c.sweep_id = s.id) cards FROM sweeps s WHERE s.started_at >= ? AND s.started_at < ? ORDER BY s.id",
      )
      .all(from, to) as { id: number; status: string; started_at: string; cards: number }[]
  ).map((s) => ({ id: Number(s.id), status: s.status, startedAt: s.started_at, cards: Number(s.cards) }));
  const ids = new Set(sweeps.map((s) => s.id));
  const verdicts = db
    .prepare("SELECT verdict, COUNT(*) n FROM judgments WHERE updated_at >= ? AND updated_at < ? GROUP BY verdict")
    .all(from, to) as { verdict: "up" | "down" | "star"; n: number }[];
  const count = (v: string) => Number(verdicts.find((r) => r.verdict === v)?.n ?? 0);
  const waiting = sweeps.length
    ? sum(
        db,
        `SELECT COUNT(*) c FROM cards c LEFT JOIN judgments j ON j.card_id = c.id WHERE j.card_id IS NULL AND c.sweep_id IN (${sweeps.map(() => "?").join(",")})`,
        ...sweeps.map((s) => s.id),
      )
    : 0;
  let picks: DigestBody["exploration"]["picks"] = [];
  try {
    picks = (
      db
        .prepare(
          `SELECT e.sweep_id, e.paper_id, p.title, j.verdict FROM ${EXPLORATION_TABLE} e JOIN papers p ON p.id = e.paper_id
           LEFT JOIN cards c ON c.paper_id = e.paper_id LEFT JOIN judgments j ON j.card_id = c.id
           WHERE e.created_at >= ? AND e.created_at < ? ORDER BY e.sweep_id`,
        )
        .all(from, to) as { sweep_id: number; paper_id: number; title: string; verdict: string | null }[]
    ).map((r) => ({
      sweepId: Number(r.sweep_id),
      paperId: Number(r.paper_id),
      title: r.title,
      verdict: r.verdict ?? null,
    }));
  } catch {
    // No exploration table yet.
  }
  const added = db
    .prepare(
      "SELECT n.stem, p.title FROM kb_notes n JOIN papers p ON p.id = n.paper_id WHERE n.created_at >= ? AND n.created_at < ? ORDER BY n.created_at",
    )
    .all(from, to) as { stem: string; title: string }[];
  const modelUsd = sum(
    db,
    "SELECT SUM(cost_usd) c FROM generations WHERE started_at >= ? AND started_at < ?",
    Date.parse(from),
    Date.parse(to),
  );
  const jevUsd = sum(
    db,
    "SELECT SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END) c FROM jev_calls WHERE created_at >= ? AND created_at < ?",
    from,
    to,
  );
  const embeddingUsd = sum(
    db,
    "SELECT SUM(cost_usd) c FROM embedding_calls WHERE error IS NULL AND created_at >= ? AND created_at < ?",
    from,
    to,
  );
  return {
    week: x.week,
    from,
    to,
    cycle: { sweeps, nightlyRuns: x.nightlyRuns },
    judgments: {
      up: count("up"),
      down: count("down"),
      star: count("star"),
      total: count("up") + count("down") + count("star"),
      waiting,
      precision: x.precision.filter((p) => ids.has(p.sweepId)),
    },
    exploration: { picks },
    knowledgeBase: { added: added.map((a) => ({ stem: a.stem, title: a.title })) },
    cost: { modelUsd, jevUsd, embeddingUsd, totalUsd: modelUsd + jevUsd + embeddingUsd },
    changes: x.changes
      .filter((c) => c.time >= from && c.time < to)
      .map((c) => ({ id: c.id, time: c.time, message: c.message, actor: c.actor })),
    lastComments: x.lastComments,
  };
}
