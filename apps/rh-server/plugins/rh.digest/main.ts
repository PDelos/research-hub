// Built-in plugin rh.digest: the daily cycle's orchestration (spec daily-cycle; design v1-1 D5). It answers the
// scheduler's nightly and weekly runs: each night it records the day's figures (later changes add error analysis
// and replays here), each week it builds the digest the user reads and comments on. It also reports where the cycle
// stands (last sweep, cards waiting, next runs).
import type { CycleStatus, DigestComment, DigestSection, DigestSummary, DigestView } from "@rh/sdk";
import type { Db } from "../../src/db.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import { PluginUnavailable, type PluginContext } from "../../src/kernel/lifecycle.ts";
import { isoWeek, localParts, type ScheduledRun } from "../../src/schedule.ts";
import type { FeedbackExports } from "../rh.feedback/main.ts";
import type { ScheduleExports } from "../rh.schedule/main.ts";
import { buildDigest } from "./digest.ts";
import { charterSection, qualitySection, upgradeSection, type Period } from "./sections.ts";
import { DigestStore } from "./store.ts";
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

/** Where the cycle stands: the last sweep and its cards still waiting, the next runs, the last night and digest. */
function cycleStatus(db: Db, store: DigestStore, scheduler: ScheduleExports["scheduler"], now: number): CycleStatus {
  const last = db
    .prepare(
      "SELECT s.id, s.status, s.started_at, s.ended_at, (SELECT COUNT(*) FROM cards c WHERE c.sweep_id = s.id) cards FROM sweeps s ORDER BY s.id DESC LIMIT 1",
    )
    .get() as { id: number; status: string; started_at: string; ended_at: string | null; cards: number } | undefined;
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
  const night = store.lastNight();
  const digest = store.latest();
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
}

function checkedComment(section: DigestSection, text: string): string {
  if (!DIGEST_SECTIONS.includes(section))
    throw new CommentInvalid(`section must be one of ${DIGEST_SECTIONS.join(", ")}`);
  const body = String(text ?? "").trim();
  if (!body) throw new CommentInvalid("the comment is empty");
  if (body.length > COMMENT_MAX) throw new CommentInvalid(`a comment is at most ${COMMENT_MAX} characters`);
  return body;
}

/** Run the knowledge review first (its model call is not the digest's), so its proposals are in this digest. */
async function reviewKnowledge(context: PluginContext) {
  try {
    const knowledge = await hostOf(context).exportsOf<KnowledgeExports>("rh.knowledge");
    return { knowledge, notes: (await knowledge.review("digest")).report.notes };
  } catch (error) {
    // The knowledge review is an advanced feature: off means no Charter section, not a failure.
    if (!(error instanceof PluginUnavailable))
      context.log.warn("digest.knowledge_review_failed", { error: String(error) });
    return { knowledge: undefined, notes: [] };
  }
}

/** A section from another plugin, or nothing when that plugin is not running. */
async function optional<T, S>(context: PluginContext, pluginId: string, section: (exports: T) => S | Promise<S>) {
  try {
    return await section(await hostOf(context).exportsOf<T>(pluginId));
  } catch {
    return undefined;
  }
}

/** The scheduler's nightly and weekly runs land here; work in progress finishes before the plugin stops. */
function handleScheduledRuns(context: PluginContext, exports: DigestExports, scheduler: ScheduleExports["scheduler"]) {
  const pending = new Set<Promise<void>>();
  let stopped = false;
  const perform = async (run: ScheduledRun) => {
    // Periods use the real time (the records carry it); the slot names the night or the week.
    if (run.kind === "nightly") {
      exports.recordNight(Date.now(), run.slot.startsWith("nightly:") ? run.slot.slice(8) : undefined);
      // The night's work of other plugins (the harness labels and recalibrates here).
      context.rh.events.emit("cycle.nightly", { runId: run.id, slot: run.slot });
    } else await exports.buildDigest(Date.now(), run.slot.startsWith("review:") ? run.slot.slice(7) : undefined);
  };
  const handle = (run: ScheduledRun) => {
    if (stopped || (run.kind !== "nightly" && run.kind !== "review")) return;
    scheduler.mark(run.id, "running");
    const work = perform(run)
      .then(() => scheduler.mark(run.id, "done"))
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        context.log.warn("cycle.run_failed", { kind: run.kind, error: reason });
        try {
          scheduler.mark(run.id, "failed", reason);
        } catch {
          // The project is closing.
        }
      });
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
}

export function activate(context: PluginContext): DigestExports {
  const host = hostOf(context);
  const { db } = host;
  const { scheduler } = context.exports["rh.schedule"] as ScheduleExports;
  const { feedback } = context.exports["rh.feedback"] as FeedbackExports;
  const store = new DigestStore(context.rh, db);

  const exports: DigestExports = {
    cycle: (now = Date.now()) => cycleStatus(db, store, scheduler, now),
    digests: (limit = 20): DigestSummary[] => store.list(limit),
    digest: (id): DigestView | undefined => store.get(id),
    comment(id, section, text): DigestComment {
      if (!store.get(id)) throw new CommentInvalid(`No digest ${id}`);
      const comment = store.addComment(id, section, checkedComment(section, text));
      // Later changes (self-improvement, the knowledge loop) act on comments.
      context.rh.events.emit("digest.comment", { digestId: id, ...comment });
      return comment;
    },
    async buildDigest(now = Date.now(), week?: string) {
      const previous = store.latest();
      const period: Period = {
        from: previous?.period_to ?? new Date(now - 7 * 86_400_000).toISOString(),
        to: new Date(now).toISOString(),
      };
      const label = week ?? isoWeek(localParts(now, scheduler.schedule().timeZone));
      const review = await reviewKnowledge(context);
      const body = buildDigest({
        db,
        week: label,
        ...period,
        nightlyRuns: store.nightsBetween(period.from, period.to),
        changes: await host.pluginHistory(200),
        lastComments: previous
          ? store
              .comments(Number(previous.id))
              .map((c) => ({ section: c.section, text: c.text, createdAt: c.createdAt }))
          : [],
        precision: feedback.precision(60),
      });
      await optional<HarnessExports, void>(context, "rh.harness", (harness) => {
        body.sources = harness.attribution(period.from, period.to);
        body.quality = qualitySection(harness, period);
      });
      const upgrade = await optional<UpgradesExports, NonNullable<typeof body.upgrade>>(context, "rh.upgrades", (u) =>
        upgradeSection(u, period),
      );
      if (upgrade) body.upgrade = upgrade;
      if (review.knowledge) body.charter = await charterSection(review.knowledge, period, review.notes);
      const id = store.add(label, period, body);
      context.log.info("digest.built", { id, week: label, sweeps: body.cycle.sweeps.length });
      return store.get(id)!;
    },
    recordNight(now = Date.now(), day = new Date(now).toISOString().slice(0, 10)) {
      const since = new Date(now - 86_400_000).toISOString();
      const count = (sql: string) => Number((db.prepare(sql).get(since) as { n: number }).n);
      const figures = {
        sweeps: count("SELECT COUNT(*) n FROM sweeps WHERE started_at >= ?"),
        judged: count("SELECT COUNT(*) n FROM judgments WHERE updated_at >= ?"),
        waiting: exports.cycle(now).waiting,
      };
      store.recordNight(day, figures, new Date(now).toISOString());
      context.log.info("cycle.night_recorded", { day, ...figures });
    },
  };
  handleScheduledRuns(context, exports, scheduler);
  return exports;
}
