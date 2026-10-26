// The schedule: a daily sweep and a weekly review in a configured time zone, requested exactly once per slot.
// Every request is a row in scheduled_runs with UNIQUE(kind, slot), so repeated ticks, restarts and races can never
// produce a second run. Only the latest missed slot is requested after downtime; older ones are recorded as skipped.
import { WEEKDAYS, type ScheduleDefaults, type Weekday } from "./config.ts";
import type { Charters, ProjectState } from "./charter.ts";
import { nowIso, Settings, type Db } from "./db.ts";
import type { Logger } from "./logger.ts";

// ---------------------------------------------------------------- time-zone helpers

interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(instant: number, tz: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

/** Offset of `tz` from UTC at `instant`, in ms. */
function offsetAt(instant: number, tz: string): number {
  const p = localParts(instant, tz);
  const seconds = new Date(instant).getUTCSeconds();
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, seconds) - Math.floor(instant / 1000) * 1000;
}

/** The instant of local wall time y-m-d hh:mm in `tz` (a time skipped by a DST jump lands just after the jump). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (p: { y: number; m: number; d: number }) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
/** Calendar arithmetic on a local date, independent of time zones. */
function shiftDate(p: { y: number; m: number; d: number }, days: number) {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: t.getUTCDay() };
}
export function isoWeek(p: { y: number; m: number; d: number }): string {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

export type RunKind = "sweep" | "nightly" | "review";
export const RUN_KINDS: readonly RunKind[] = ["sweep", "nightly", "review"];

export interface Slot {
  kind: RunKind;
  key: string;
  at: number;
}

const hm = (time: string) => time.split(":").map(Number) as [number, number];

/** The daily (sweep or nightly) slot `back` days before the latest one that is due at `now`. */
export function dailySlot(now: number, time: string, tz: string, back = 0, kind: "sweep" | "nightly" = "sweep"): Slot {
  const [hh, mm] = hm(time);
  let date = localParts(now, tz) as { y: number; m: number; d: number };
  if (zonedToUtc(date.y, date.m, date.d, hh, mm, tz) > now) date = shiftDate(date, -1);
  date = shiftDate(date, -back);
  return { kind, key: `${kind}:${ymd(date)}`, at: zonedToUtc(date.y, date.m, date.d, hh, mm, tz) };
}

/** The review slot `back` weeks before the latest one that is due at `now`. */
export function weeklySlot(now: number, weekday: Weekday, time: string, tz: string, back = 0): Slot {
  const [hh, mm] = hm(time);
  const target = WEEKDAYS.indexOf(weekday);
  const today = localParts(now, tz);
  let date = shiftDate(today, -((today.weekday - target + 7) % 7));
  if (zonedToUtc(date.y, date.m, date.d, hh, mm, tz) > now) date = shiftDate(date, -7);
  date = shiftDate(date, -7 * back);
  return { kind: "review", key: `review:${isoWeek(date)}`, at: zonedToUtc(date.y, date.m, date.d, hh, mm, tz) };
}

// ---------------------------------------------------------------- schedule settings

export interface ScheduleSettings {
  timeZone: string;
  sweep: { enabled: boolean; time: string };
  /** The nightly run of the daily cycle. */
  nightly: { enabled: boolean; time: string };
  /** The weekly digest (stored as the review kind). */
  review: { enabled: boolean; weekday: Weekday; time: string };
}

export class ScheduleInvalid extends Error {}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---------------------------------------------------------------- runs

export interface ScheduledRun {
  id: number;
  kind: RunKind;
  slot: string;
  slotAt: number | null;
  trigger: "scheduled" | "manual";
  status: "requested" | "running" | "done" | "failed" | "skipped";
  reason: string | null;
  createdAt: string;
}

const toRun = (r: any): ScheduledRun => ({
  id: r.id,
  kind: r.kind,
  slot: r.slot,
  slotAt: r.slot_at ?? null,
  trigger: r.trigger,
  status: r.status,
  reason: r.reason ?? null,
  createdAt: r.created_at,
});

export const MISSED = "missed while the hub was down";
const CATCH_UP_LIMIT = 60;

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly requestedListeners = new Set<(run: ScheduledRun) => void>();

  constructor(
    private readonly deps: {
      db: Db;
      settings: Settings;
      state: ProjectState;
      charters: Charters;
      defaults: ScheduleDefaults;
      log: Logger;
    },
  ) {}

  /** Called after a run is recorded as requested (the sweep runner picks sweeps up from here). */
  onRequested(listener: (run: ScheduledRun) => void): () => void {
    this.requestedListeners.add(listener);
    return () => this.requestedListeners.delete(listener);
  }

  schedule(): ScheduleSettings {
    const d = this.deps.defaults;
    const saved = this.deps.settings.get<Partial<Omit<ScheduleSettings, "timeZone">>>("schedule", {});
    return {
      timeZone: d.timeZone,
      sweep: { enabled: true, time: d.sweepTime, ...saved.sweep },
      nightly: { enabled: true, time: d.nightlyTime ?? "02:00", ...saved.nightly },
      review: { enabled: true, weekday: d.review.weekday, time: d.review.time, ...saved.review },
    };
  }

  /** Save schedule changes; saved values override the environment defaults from then on. */
  setSchedule(patch: unknown): ScheduleSettings {
    const p = (patch ?? {}) as Record<string, any>;
    const current = this.schedule();
    const next = { sweep: { ...current.sweep }, nightly: { ...current.nightly }, review: { ...current.review } };
    for (const kind of ["sweep", "nightly"] as const) {
      const part = p[kind];
      if (part === undefined) continue;
      if (part.enabled !== undefined) {
        if (typeof part.enabled !== "boolean") throw new ScheduleInvalid(`${kind}.enabled must be true or false`);
        next[kind].enabled = part.enabled;
      }
      if (part.time !== undefined) {
        if (!TIME.test(part.time)) throw new ScheduleInvalid(`${kind}.time must be HH:MM (24 h)`);
        next[kind].time = part.time;
      }
    }
    if (p.review !== undefined) {
      if (p.review.enabled !== undefined) {
        if (typeof p.review.enabled !== "boolean") throw new ScheduleInvalid("review.enabled must be true or false");
        next.review.enabled = p.review.enabled;
      }
      if (p.review.time !== undefined) {
        if (!TIME.test(p.review.time)) throw new ScheduleInvalid("review.time must be HH:MM (24 h)");
        next.review.time = p.review.time;
      }
      if (p.review.weekday !== undefined) {
        if (!WEEKDAYS.includes(p.review.weekday))
          throw new ScheduleInvalid(`review.weekday must be one of ${WEEKDAYS.join(", ")}`);
        next.review.weekday = p.review.weekday;
      }
    }
    this.deps.settings.set("schedule", next);
    this.deps.log.info("schedule.updated", next);
    return this.schedule();
  }

  private latest(kind: RunKind, now: number, back = 0): Slot {
    const s = this.schedule();
    return kind === "review"
      ? weeklySlot(now, s.review.weekday, s.review.time, s.timeZone, back)
      : dailySlot(now, s[kind].time, s.timeZone, back, kind);
  }

  private record(
    slot: { kind: Slot["kind"]; key: string; at: number | null },
    trigger: ScheduledRun["trigger"],
    status: ScheduledRun["status"],
    reason?: string,
  ): ScheduledRun | undefined {
    const res = this.deps.db
      .prepare(
        "INSERT OR IGNORE INTO scheduled_runs (kind, slot, slot_at, trigger, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(slot.kind, slot.key, slot.at, trigger, status, reason ?? null, nowIso());
    if (Number(res.changes) === 0) return undefined;
    const run = toRun(
      this.deps.db.prepare("SELECT * FROM scheduled_runs WHERE id = ?").get(Number(res.lastInsertRowid)),
    );
    this.deps.log.info("schedule.recorded", { kind: run.kind, slot: run.slot, status: run.status, reason: run.reason });
    if (run.status === "requested")
      queueMicrotask(() => {
        for (const listener of this.requestedListeners) {
          try {
            listener(run);
          } catch (error) {
            this.deps.log.error("schedule.listener_failed", { error: String(error) });
          }
        }
      });
    return run;
  }

  private exists(kind: string, key: string): boolean {
    return !!this.deps.db.prepare("SELECT 1 FROM scheduled_runs WHERE kind = ? AND slot = ?").get(kind, key);
  }

  private running(kind: string): boolean {
    return !!this.deps.db.prepare("SELECT 1 FROM scheduled_runs WHERE kind = ? AND status = 'running'").get(kind);
  }

  /** Why a run cannot start now, or undefined when it can. */
  private ineligible(kind: Slot["kind"], slotAt: number | null, manual: boolean): string | undefined {
    const { state, charters } = this.deps;
    if (!manual) {
      if (state.paused()) return "project paused";
      const resumed = state.resumedAt();
      if (slotAt !== null && resumed !== undefined && slotAt < resumed) return "project paused";
    }
    if (!charters.approved()) return "charter not approved";
    if (this.running(kind)) return `${kind} already running`;
    return undefined;
  }

  /**
   * Earliest instant a missed slot may be noted from: the last recorded scheduled slot of this kind (and never before
   * a resume). With no history there is nothing to catch up, so no skipped records are invented.
   */
  private lowerBound(kind: Slot["kind"]): number | undefined {
    const last = this.deps.db
      .prepare("SELECT MAX(slot_at) at FROM scheduled_runs WHERE kind = ? AND trigger = 'scheduled'")
      .get(kind) as { at: number | null };
    if (last.at === null) return undefined;
    return Math.max(last.at, this.deps.state.resumedAt() ?? 0);
  }

  /** Check every kind at `now`; returns the runs recorded by this tick. */
  tick(now = Date.now()): ScheduledRun[] {
    const recorded: ScheduledRun[] = [];
    const schedule = this.schedule();
    for (const kind of RUN_KINDS) {
      if (!schedule[kind].enabled) continue;
      const slot = this.latest(kind, now);
      if (this.exists(kind, slot.key)) continue;
      const reason = this.ineligible(kind, slot.at, false);
      if (!reason) {
        // Older missed slots since the last recorded one are noted once each as skipped, never requested.
        const bound = this.lowerBound(kind);
        for (let back = 1; bound !== undefined && back <= CATCH_UP_LIMIT; back++) {
          const older = this.latest(kind, now, back);
          if (older.at <= bound || this.exists(kind, older.key)) break;
          const run = this.record(older, "scheduled", "skipped", MISSED);
          if (run) recorded.push(run);
        }
      }
      const run = this.record(slot, "scheduled", reason ? "skipped" : "requested", reason);
      if (run) recorded.push(run);
    }
    return recorded;
  }

  /** Request a run now; it never occupies a scheduled slot. */
  trigger(kind: Slot["kind"], now = Date.now()): ScheduledRun {
    const reason = this.ineligible(kind, null, true);
    const run = this.record(
      { kind, key: `manual:${new Date(now).toISOString()}:${Math.random().toString(36).slice(2, 8)}`, at: null },
      "manual",
      reason ? "skipped" : "requested",
      reason,
    );
    return run!;
  }

  /** Record how a requested run went (the plugin that ran it calls this). */
  mark(id: number, status: "running" | "done" | "failed", reason?: string): void {
    this.deps.db
      .prepare("UPDATE scheduled_runs SET status = ?, reason = COALESCE(?, reason) WHERE id = ?")
      .run(status, reason ?? null, id);
  }

  runs(limit = 100): ScheduledRun[] {
    return (this.deps.db.prepare("SELECT * FROM scheduled_runs ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(
      toRun,
    );
  }

  /** The next scheduled time of each enabled kind, only while the project is active. */
  next(now = Date.now()): { sweep: string | null; nightly: string | null; review: string | null; timeZone: string } {
    const schedule = this.schedule();
    const active = this.deps.state.status() === "active";
    const upcoming = (kind: Slot["kind"]) => {
      if (!active || !schedule[kind].enabled) return null;
      // The latest due slot one period ahead is the next slot: probe forward until it is after now.
      for (const ahead of [1, 2, 8]) {
        const probe = now + (kind === "review" ? ahead * 7 * 86_400_000 : ahead * 86_400_000);
        const slot = this.latest(kind, probe);
        if (slot.at > now) {
          let s = slot;
          for (let back = 1; back <= 3; back++) {
            const earlier = this.latest(kind, probe, back);
            if (earlier.at > now) s = earlier;
            else break;
          }
          return new Date(s.at).toISOString();
        }
      }
      return null;
    };
    return {
      sweep: upcoming("sweep"),
      nightly: upcoming("nightly"),
      review: upcoming("review"),
      timeZone: schedule.timeZone,
    };
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    const run = () => {
      try {
        this.tick();
      } catch (error) {
        this.deps.log.error("schedule.tick_failed", { error: String(error) });
      }
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
