// Built-in plugin rh.digest: the daily cycle's orchestration (spec daily-cycle; design v1-1 D5). It answers the
// scheduler's nightly and weekly runs: each night it records the day's figures (later changes add error analysis
// and replays here), each week it builds the digest the user reads and comments on. It also reports where the cycle
// stands (last sweep, cards waiting, next runs).
import type { CycleStatus, DigestBody, DigestComment, DigestSection, DigestSummary, DigestView } from "@rh/sdk";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { isoWeek, localParts, type ScheduledRun } from "../../src/schedule.ts";
import type { FeedbackExports } from "../rh.feedback/main.ts";
import type { ScheduleExports } from "../rh.schedule/main.ts";
import { buildDigest } from "./digest.ts";
import type { HarnessExports } from "../rh.harness/main.ts";
import type { UpgradesExports } from "../rh.upgrades/main.ts";
import type { KnowledgeExports } from "../rh.knowledge/main.ts";

export const DIGEST_SECTIONS: readonly DigestSection[] = [
  "cycle",
  "judgments",
  "exploration",
  "knowledgeBase",
  "quality",
  "sources",
  "upgrade",
  "charter",
  "cost",
  "changes",
  "general",
];
const COMMENT_MAX = 2_000;

export interface DigestExports {
  cycle(now?: number): CycleStatus;
  digests(limit?: number): DigestSummary[];
  digest(id: number): DigestView | undefined;
  comment(id: number, section: DigestSection, text: string): DigestComment;
  /** Build the digest now (the weekly run calls this). */
  buildDigest(now?: number, week?: string): Promise<DigestView>;
  /** Record the night's figures (the nightly run calls this); `day` defaults to today. */
  recordNight(now?: number, day?: string): void;
}

export class CommentInvalid extends Error {}

export function activate(context: PluginContext): DigestExports {
  const host = hostOf(context);
  const { db } = host;
  const { rh } = context;
  const { scheduler } = context.exports["rh.schedule"] as ScheduleExports;
  const { feedback } = context.exports["rh.feedback"] as FeedbackExports;
  const T = { digests: rh.db.table("digests"), comments: rh.db.table("comments"), nights: rh.db.table("nights") };
  rh.db.migrate([
    {
      version: 1,
      sql: `CREATE TABLE ${T.digests} (id INTEGER PRIMARY KEY, week TEXT NOT NULL, period_from TEXT NOT NULL,
              period_to TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE ${T.comments} (id INTEGER PRIMARY KEY, digest_id INTEGER NOT NULL, section TEXT NOT NULL,
              text TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE ${T.nights} (day TEXT PRIMARY KEY, figures_json TEXT NOT NULL, created_at TEXT NOT NULL);`,
    },
  ]);

  const commentsOf = (digestId: number): DigestComment[] =>
    (
      db
        .prepare(`SELECT id, section, text, created_at FROM ${T.comments} WHERE digest_id = ? ORDER BY id`)
        .all(digestId) as {
        id: number;
        section: string;
        text: string;
        created_at: string;
      }[]
    ).map((c) => ({ id: Number(c.id), section: c.section, text: c.text, createdAt: c.created_at }));
  const latest = () =>
    db.prepare(`SELECT id, week, period_to, created_at FROM ${T.digests} ORDER BY id DESC LIMIT 1`).get() as
      | { id: number; week: string; period_to: string; created_at: string }
      | undefined;

  const exports: DigestExports = {
    cycle(now = Date.now()) {
      const last = db
        .prepare(
          "SELECT s.id, s.status, s.started_at, s.ended_at, (SELECT COUNT(*) FROM cards c WHERE c.sweep_id = s.id) cards FROM sweeps s ORDER BY s.id DESC LIMIT 1",
        )
        .get() as
        | { id: number; status: string; started_at: string; ended_at: string | null; cards: number }
        | undefined;
      const waiting = last
        ? Number(
            (
              db
                .prepare(
                  "SELECT COUNT(*) n FROM cards c LEFT JOIN judgments j ON j.card_id = c.id WHERE c.sweep_id = ? AND j.card_id IS NULL",
                )
                .get(last.id) as { n: number }
            ).n,
          )
        : 0;
      const night = db.prepare(`SELECT created_at FROM ${T.nights} ORDER BY day DESC LIMIT 1`).get() as
        | { created_at: string }
        | undefined;
      const digest = latest();
      return {
        lastSweep: last
          ? {
              id: Number(last.id),
              status: last.status,
              cards: Number(last.cards),
              startedAt: last.started_at,
              endedAt: last.ended_at,
            }
          : null,
        waiting,
        next: scheduler.next(now),
        lastNightly: night ? { at: night.created_at } : null,
        lastDigest: digest ? { id: Number(digest.id), week: digest.week, createdAt: digest.created_at } : null,
      };
    },
    digests(limit = 20) {
      return (
        db
          .prepare(
            `SELECT d.id, d.week, d.period_from, d.period_to, d.created_at, (SELECT COUNT(*) FROM ${T.comments} c WHERE c.digest_id = d.id) comments FROM ${T.digests} d ORDER BY d.id DESC LIMIT ?`,
          )
          .all(limit) as {
          id: number;
          week: string;
          period_from: string;
          period_to: string;
          created_at: string;
          comments: number;
        }[]
      ).map((d) => ({
        id: Number(d.id),
        week: d.week,
        from: d.period_from,
        to: d.period_to,
        createdAt: d.created_at,
        comments: Number(d.comments),
      }));
    },
    digest(id) {
      const row = db.prepare(`SELECT id, body_json, created_at FROM ${T.digests} WHERE id = ?`).get(id) as
        | { id: number; body_json: string; created_at: string }
        | undefined;
      if (!row) return undefined;
      return {
        ...(JSON.parse(row.body_json) as DigestBody),
        id: Number(row.id),
        createdAt: row.created_at,
        comments: commentsOf(Number(row.id)),
      };
    },
    comment(id, section, text) {
      if (!exports.digest(id)) throw new CommentInvalid(`No digest ${id}`);
      if (!DIGEST_SECTIONS.includes(section))
        throw new CommentInvalid(`section must be one of ${DIGEST_SECTIONS.join(", ")}`);
      const body = String(text ?? "").trim();
      if (!body) throw new CommentInvalid("the comment is empty");
      if (body.length > COMMENT_MAX) throw new CommentInvalid(`a comment is at most ${COMMENT_MAX} characters`);
      const createdAt = new Date().toISOString();
      const r = db
        .prepare(`INSERT INTO ${T.comments} (digest_id, section, text, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, section, body, createdAt);
      const comment = { id: Number(r.lastInsertRowid), section, text: body, createdAt };
      // Later changes (self-improvement, the knowledge loop) act on comments.
      rh.events.emit("digest.comment", { digestId: id, ...comment });
      return comment;
    },
    async buildDigest(now = Date.now(), week?: string) {
      const previous = latest();
      const to = new Date(now).toISOString();
      const from = previous?.period_to ?? new Date(now - 7 * 86_400_000).toISOString();
      const tz = scheduler.schedule().timeZone;
      const label = week ?? isoWeek(localParts(now, tz));
      const nightlyRuns = Number(
        (
          db.prepare(`SELECT COUNT(*) n FROM ${T.nights} WHERE created_at >= ? AND created_at < ?`).get(from, to) as {
            n: number;
          }
        ).n,
      );
      // The knowledge review runs first (its model call is not the digest's), so its proposals are in this digest.
      let knowledge: KnowledgeExports | undefined;
      let reviewNotes: string[] = [];
      try {
        knowledge = await host.exportsOf<KnowledgeExports>("rh.knowledge");
        reviewNotes = (await knowledge.review("digest")).report.notes;
      } catch (error) {
        context.log.warn("digest.knowledge_review_failed", { error: String(error) });
      }
      const body = buildDigest({
        db,
        week: label,
        from,
        to,
        nightlyRuns,
        changes: await host.pluginHistory(200),
        lastComments: previous
          ? commentsOf(Number(previous.id)).map((c) => ({ section: c.section, text: c.text, createdAt: c.createdAt }))
          : [],
        precision: feedback.precision(60),
      });
      // The harness's view of the week, when it runs (it is a separate plugin).
      try {
        const harness = await host.exportsOf<HarnessExports>("rh.harness");
        const q = harness.quality();
        body.sources = harness.attribution(from, to);
        body.quality = {
          judge: q.judge ? { agreement: q.judge.agreement, cases: q.judge.cases, trusted: q.judge.trusted } : null,
          replays: harness
            .replays(200)
            // The weekly upgrade's replays are listed in its own section.
            .filter((r) => r.createdAt >= from && r.createdAt < to && !r.requestedBy.startsWith("upgrade-"))
            .map((r) => ({
              id: r.id,
              variant: r.variant as Record<string, unknown>,
              verdict: r.report.verdict,
              heldOutDiff: r.report.heldOut.diff,
              low: r.report.heldOut.low,
              high: r.report.heldOut.high,
              requestedBy: r.requestedBy,
              createdAt: r.createdAt,
            })),
        };
      } catch {
        // No harness: the digest goes without its quality section.
      }
      try {
        const upgrades = await host.exportsOf<UpgradesExports>("rh.upgrades");
        const proposals = upgrades.proposals();
        body.upgrade = {
          runs: upgrades
            .runs(50)
            // By when they finished: a run the digest's night started is in next week's digest.
            .filter((u) => u.finishedAt !== null && u.finishedAt >= from && u.finishedAt < to)
            .map((u) => ({
              id: u.id,
              focus: u.focus,
              reason: u.reason,
              status: u.status,
              result: u.report?.result ?? "",
              tried: u.report?.tried.length ?? 0,
              proposals: proposals
                .filter((p) => p.runId === u.id)
                .map((p) => ({ id: p.id, kind: p.kind, status: p.status, commit: p.commit })),
              startedAt: u.startedAt,
            })),
        };
      } catch {
        // No weekly upgrade plugin: no upgrade section.
      }
      if (knowledge)
        body.charter = {
          proposals: knowledge
            .proposals()
            .filter(
              (p) => p.status === "proposed" || (p.decidedAt !== null && p.decidedAt >= from && p.decidedAt < to),
            ),
          reviewNotes,
          finders: await knowledge.finders(),
        };
      const r = db
        .prepare(
          `INSERT INTO ${T.digests} (week, period_from, period_to, body_json, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(label, from, to, JSON.stringify(body), to);
      context.log.info("digest.built", {
        id: Number(r.lastInsertRowid),
        week: label,
        sweeps: body.cycle.sweeps.length,
      });
      return exports.digest(Number(r.lastInsertRowid))!;
    },
    recordNight(now = Date.now(), day = new Date(now).toISOString().slice(0, 10)) {
      const since = new Date(now - 86_400_000).toISOString();
      const figures = {
        sweeps: Number(
          (db.prepare("SELECT COUNT(*) n FROM sweeps WHERE started_at >= ?").get(since) as { n: number }).n,
        ),
        judged: Number(
          (db.prepare("SELECT COUNT(*) n FROM judgments WHERE updated_at >= ?").get(since) as { n: number }).n,
        ),
        waiting: exports.cycle(now).waiting,
      };
      db.prepare(`INSERT OR REPLACE INTO ${T.nights} (day, figures_json, created_at) VALUES (?, ?, ?)`).run(
        day,
        JSON.stringify(figures),
        new Date(now).toISOString(),
      );
      context.log.info("cycle.night_recorded", { day, ...figures });
    },
  };

  // The scheduler's nightly and weekly runs land here. Work in progress finishes before the plugin stops.
  const pending = new Set<Promise<void>>();
  let stopped = false;
  const handle = (run: ScheduledRun) => {
    if (stopped || (run.kind !== "nightly" && run.kind !== "review")) return;
    scheduler.mark(run.id, "running");
    const work = (async () => {
      try {
        // Periods use the real time (the records carry it); the slot names the night or the week.
        if (run.kind === "nightly") {
          exports.recordNight(Date.now(), run.slot.startsWith("nightly:") ? run.slot.slice(8) : undefined);
          // The night's work of other plugins (the harness labels and recalibrates here).
          rh.events.emit("cycle.nightly", { runId: run.id, slot: run.slot });
        } else await exports.buildDigest(Date.now(), run.slot.startsWith("review:") ? run.slot.slice(7) : undefined);
        scheduler.mark(run.id, "done");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        context.log.warn("cycle.run_failed", { kind: run.kind, error: reason });
        try {
          scheduler.mark(run.id, "failed", reason);
        } catch {
          // The project is closing.
        }
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  context.subscriptions.push(
    { dispose: scheduler.onRequested(handle) },
    {
      dispose: async () => {
        stopped = true;
        await Promise.all(pending);
      },
    },
  );
  return exports;
}
