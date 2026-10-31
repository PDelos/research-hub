// The daily sweep (spec paper-sweep; design D1, D3, D7): plan → gather → dedupe → gate → enrich → level → rank, then
// the card writer. Every phase commits its results before the phase pointer moves, and Jev answers are stored per
// paper (PaperDecisions), so a sweep resumes after a crash without paying twice. A failing phase retries after
// 30 s, 2 min and 8 min, then the sweep fails with the error.
import type { Charters } from "../charter.ts";
import { withCostTag } from "../cost-tag.ts";
import { nowIso, type Db, type Settings } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { PaperService } from "../papers/service.ts";
import type { PaperDecisions } from "./decisions.ts";
import { SweepPhases } from "./phases.ts";
import type { PlannedQuery, RankWeights, TargetLevel } from "./policy.ts";
import { runReason, toRecord, toSweepPaper, type SweepPaper, type SweepPaperRow, type SweepRow } from "./records.ts";

export * from "./policy.ts";
export { ORIENTATION_JUDGED, RESULTS_PER_SOURCE } from "./phases.ts";
export type { SweepPaper } from "./records.ts";

export const PHASES = ["plan", "gather", "dedupe", "gate", "enrich", "level", "rank", "cards"] as const;
export type Phase = (typeof PHASES)[number];
export type SweepStatus = "running" | "completed" | "no_new_papers" | "failed";

export const DEFAULT_RETRY_DELAYS = [30_000, 120_000, 480_000];
export const CARDS_PER_SWEEP = { default: 7, min: 1, max: 15 };

export interface SweepRecord {
  id: number;
  scheduledRunId?: number;
  trigger: string;
  status: SweepStatus;
  phase: Phase;
  orientation: boolean;
  queries: PlannedQuery[];
  windowSince?: string;
  counts: Record<string, number>;
  phases: Partial<Record<Phase, PhaseRecord>>;
  attempts: number;
  nextRetryAt?: number;
  error?: string;
  conversationId?: number;
  submissionId?: number;
  completion?: { presented: number[]; skipped: { paperId: number; reason: string }[] };
  cost?: {
    jevUsd: number;
    jevCalls: number;
    embeddingUsd: number;
    embeddingCalls: number;
    modelUsd: number;
    totalUsd: number;
  };
  startedAt: string;
  endedAt?: string;
}

export interface PhaseRecord {
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt?: string;
  attempts: number;
  counts?: Record<string, number>;
  error?: string;
  detail?: unknown;
}

/** What the runner needs from the card writer (design D6). */
export interface CardStage {
  /** Start (or re-attach to) the card-writing turn of a sweep; the writer calls `runner.cardsSettled` when done. */
  start(sweep: SweepRecord): Promise<void>;
  /** After a restart: re-attach to a sweep whose turn was in flight. */
  resume(sweep: SweepRecord): void;
}

export interface SweepDeps {
  db: Db;
  settings: Settings;
  charters: Charters;
  papers: PaperService;
  decisions: PaperDecisions;
  log: Logger;
  /** Papers the user has judged (v0.4); orientation mode lasts until 10. */
  judged?: () => number;
  /** Paper ids the user has judged (v0.4), dropped in dedupe. */
  judgedPaper?: (paperId: number) => boolean;
  /** Effective weight after the user's judgments (v0.4); `fallback` is the charter weight (1 for a source). */
  weight?: (kind: "question" | "query" | "source", key: string, fallback: number) => number;
  now?: () => number;
  random?: () => number;
  retryDelaysMs?: number[];
  /** Cards per sweep from the rh.sweep plugin setting (v1-1); the settings table otherwise. */
  cardsPerSweep?: () => number;
  /**
   * Exploration picks (v1-1): given the gated papers best first and the number of card slots, the papers that take
   * the last slots (chosen from outside the top ones). None when absent.
   */
  explore?: (x: { sweepId: number; ranked: number[]; slots: number }) => number[];
  /** Gate thresholds and rank weights from rh.sweep settings (v1-2); the commands' policies and defaults otherwise. */
  knobs?: () => { relevanceMin?: number; worthMin?: number; rankWeights?: RankWeights; level?: TargetLevel };
}

// ---------------------------------------------------------------- runner

export class SweepRunner {
  private cards?: CardStage;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly driving = new Set<number>();
  private closed = false;
  private readonly listeners = new Set<(sweep: SweepRecord) => void>();

  private readonly phases: SweepPhases;

  /** The approved charter with effective weights (the user's judgments nudge question and query weights). */
  charter() {
    return this.phases.charter();
  }

  constructor(private readonly deps: SweepDeps) {
    this.phases = new SweepPhases(deps, {
      now: () => this.now(),
      cardsPerSweep: () => this.cardsPerSweep(),
      setDetail: (id, phase, detail) => this.setDetail(id, phase, detail),
      noNewPapers: (id) => this.finish(id, "no_new_papers"),
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  setCardStage(cards: CardStage): void {
    this.cards = cards;
  }

  /** Called with the sweep after every change (SSE). */
  onChange(listener: (sweep: SweepRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cardsPerSweep(): number {
    return this.deps.cardsPerSweep?.() ?? this.deps.settings.get("cards_per_sweep", CARDS_PER_SWEEP.default);
  }

  setCardsPerSweep(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < CARDS_PER_SWEEP.min ||
      value > CARDS_PER_SWEEP.max
    )
      throw new RangeError(
        `cards_per_sweep must be a whole number from ${CARDS_PER_SWEEP.min} to ${CARDS_PER_SWEEP.max}`,
      );
    this.deps.settings.set("cards_per_sweep", value);
    return value;
  }

  get(id: number): SweepRecord | undefined {
    const row = this.deps.db.prepare("SELECT * FROM sweeps WHERE id = ?").get(id) as SweepRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(limit = 50): SweepRecord[] {
    return (
      this.deps.db.prepare("SELECT * FROM sweeps ORDER BY id DESC LIMIT ?").all(limit) as unknown as SweepRow[]
    ).map(toRecord);
  }

  running(): SweepRecord | undefined {
    const row = this.deps.db.prepare("SELECT * FROM sweeps WHERE status = 'running' ORDER BY id LIMIT 1").get() as
      | SweepRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Papers of a sweep with their state, best rank first. */
  papers(sweepId: number): SweepPaper[] {
    return (
      this.deps.db
        .prepare("SELECT * FROM sweep_papers WHERE sweep_id = ? ORDER BY rank IS NULL, rank, paper_id")
        .all(sweepId) as unknown as SweepPaperRow[]
    ).map(toSweepPaper);
  }

  /** Claim requested sweep slots and resume interrupted sweeps (startup, and whenever a slot is recorded). */
  pickUp(): void {
    if (this.closed) return;
    for (const sweep of (
      this.deps.db.prepare("SELECT * FROM sweeps WHERE status = 'running'").all() as unknown as SweepRow[]
    ).map(toRecord)) {
      if (sweep.phase === "cards") this.cards?.resume(sweep);
      else this.schedule(sweep);
    }
    if (this.running()) return;
    const requested = this.deps.db
      .prepare(
        "SELECT id, trigger FROM scheduled_runs WHERE kind = 'sweep' AND status = 'requested' ORDER BY id LIMIT 1",
      )
      .get() as { id: number; trigger: string } | undefined;
    if (requested) this.start(requested.trigger, Number(requested.id));
  }

  /** Start a sweep now (a claimed scheduled run, or directly in tests). */
  start(trigger: string, scheduledRunId?: number): SweepRecord {
    const existing = this.running();
    if (existing) return existing;
    const result = this.deps.db
      .prepare(
        "INSERT INTO sweeps (scheduled_run_id, trigger, status, phase, started_at) VALUES (?, ?, 'running', 'plan', ?)",
      )
      .run(scheduledRunId ?? null, trigger, nowIso());
    const id = Number(result.lastInsertRowid);
    if (scheduledRunId !== undefined)
      this.deps.db.prepare("UPDATE scheduled_runs SET status = 'running' WHERE id = ?").run(scheduledRunId);
    this.deps.log.info("sweep.started", { sweep: id, trigger, scheduledRunId });
    const sweep = this.get(id)!;
    this.emit(sweep);
    this.schedule(sweep);
    return sweep;
  }

  /** Wait until a sweep leaves the code phases (tests and the live check). */
  async settled(id: number, timeoutMs = 120_000): Promise<SweepRecord> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const sweep = this.get(id)!;
      if (sweep.status !== "running" && !this.driving.has(id)) return sweep;
      if (Date.now() > end) throw new Error(`sweep ${id} still ${sweep.status} in phase ${sweep.phase}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    while (this.driving.size) await new Promise((r) => setTimeout(r, 10));
  }

  private schedule(sweep: SweepRecord): void {
    if (this.closed || this.driving.has(sweep.id) || this.timers.has(sweep.id)) return;
    const wait = Math.max(0, (sweep.nextRetryAt ?? 0) - this.now());
    if (wait > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(sweep.id);
        const current = this.get(sweep.id);
        if (current?.status === "running") void this.drive(sweep.id);
      }, wait);
      timer.unref?.();
      this.timers.set(sweep.id, timer);
    } else void this.drive(sweep.id);
  }

  /** Run phases until the sweep finishes, waits for a retry, or hands over to the card writer. */
  private async drive(id: number): Promise<void> {
    if (this.driving.has(id) || this.closed) return;
    this.driving.add(id);
    let retry = false;
    try {
      await withCostTag(`sweep:${id}`, async () => {
        for (;;) {
          if (this.closed) return;
          const sweep = this.get(id);
          if (!sweep || sweep.status !== "running") return;
          if (sweep.phase === "cards") {
            if (!this.cards) return this.finish(id, "completed");
            await this.cards.start(sweep);
            return;
          }
          const phase = sweep.phase;
          this.phaseStarted(id, phase, sweep.attempts + 1);
          try {
            const counts = await this.phases.run(phase, sweep);
            this.phaseDone(id, phase, counts);
            const after = this.get(id)!;
            if (after.status !== "running") return;
          } catch (error) {
            if (this.closed) return;
            const message = error instanceof Error ? error.message : String(error);
            retry = this.phaseFailed(id, phase, message) !== undefined;
            return;
          }
        }
      });
    } catch (error) {
      this.deps.log.error("sweep.drive_failed", {
        sweep: id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.driving.delete(id);
    }
    if (retry) this.schedule(this.get(id)!);
  }

  // ---- bookkeeping

  private patchPhase(id: number, phase: Phase, patch: Partial<PhaseRecord>): void {
    const sweep = this.get(id)!;
    const phases = {
      ...sweep.phases,
      [phase]: { ...(sweep.phases[phase] ?? { status: "running", startedAt: nowIso(), attempts: 0 }), ...patch },
    };
    this.deps.db.prepare("UPDATE sweeps SET phases_json = ? WHERE id = ?").run(JSON.stringify(phases), id);
  }

  private setDetail(id: number, phase: Phase, detail: unknown): void {
    this.patchPhase(id, phase, { detail });
  }

  private phaseStarted(id: number, phase: Phase, attempt: number): void {
    const existing = this.get(id)!.phases[phase];
    this.patchPhase(id, phase, {
      status: "running",
      startedAt: existing?.startedAt ?? nowIso(),
      attempts: attempt,
      error: undefined,
    });
    this.deps.log.info("sweep.phase_started", { sweep: id, phase, attempt });
  }

  private phaseDone(id: number, phase: Phase, counts: Record<string, number>): void {
    this.patchPhase(id, phase, { status: "done", endedAt: nowIso(), counts });
    const sweep = this.get(id)!;
    const totals = { ...sweep.counts, ...counts };
    const next = PHASES[PHASES.indexOf(phase) + 1];
    if (sweep.status === "running")
      this.deps.db
        .prepare("UPDATE sweeps SET phase = ?, counts_json = ?, attempts = 0, next_retry_at = NULL WHERE id = ?")
        .run(next, JSON.stringify(totals), id);
    else this.deps.db.prepare("UPDATE sweeps SET counts_json = ? WHERE id = ?").run(JSON.stringify(totals), id);
    this.deps.log.info("sweep.phase_done", { sweep: id, phase, counts });
    this.emit(this.get(id)!);
  }

  /** Record a failed attempt; returns the retry time, or undefined when the sweep failed for good. */
  private phaseFailed(id: number, phase: Phase, error: string): number | undefined {
    const sweep = this.get(id)!;
    const attempts = sweep.attempts + 1;
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    this.patchPhase(id, phase, { status: "failed", error });
    if (attempts > delays.length) {
      this.deps.db.prepare("UPDATE sweeps SET attempts = ? WHERE id = ?").run(attempts, id);
      this.finish(id, "failed", `${phase} failed after ${attempts} attempts: ${error}`);
      return undefined;
    }
    const at = this.now() + delays[attempts - 1];
    this.deps.db
      .prepare("UPDATE sweeps SET attempts = ?, next_retry_at = ?, error = ? WHERE id = ?")
      .run(attempts, at, error, id);
    this.deps.log.warn("sweep.phase_failed", {
      sweep: id,
      phase,
      attempt: attempts,
      error,
      retryInMs: delays[attempts - 1],
    });
    this.emit(this.get(id)!);
    return at;
  }

  /** Card writer finished: completed when complete_sweep was recorded, failed otherwise. */
  cardsSettled(id: number, outcome: { ok: true } | { ok: false; reason: string }): void {
    const sweep = this.get(id);
    if (!sweep || sweep.status !== "running") return;
    this.patchPhase(id, "cards", {
      status: outcome.ok ? "done" : "failed",
      endedAt: nowIso(),
      ...(outcome.ok ? {} : { error: outcome.reason }),
    });
    if (outcome.ok) this.finish(id, "completed");
    else this.finish(id, "failed", outcome.reason);
  }

  /** Record the cards turn (conversation and submission) so a restart can re-attach. */
  cardsStarted(id: number, conversationId: number, submissionId: number): void {
    this.deps.db
      .prepare("UPDATE sweeps SET conversation_id = ?, submission_id = ? WHERE id = ?")
      .run(conversationId, submissionId, id);
    this.patchPhase(id, "cards", { status: "running", startedAt: nowIso(), attempts: 1 });
    this.emit(this.get(id)!);
  }

  recordCompletion(id: number, completion: NonNullable<SweepRecord["completion"]>): void {
    this.deps.db.prepare("UPDATE sweeps SET completion_json = ? WHERE id = ?").run(JSON.stringify(completion), id);
  }

  private finish(id: number, status: Exclude<SweepStatus, "running">, error?: string): void {
    const sweep = this.get(id)!;
    const tag = `sweep:${id}`;
    const jev = this.deps.db
      .prepare(
        "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) c FROM jev_calls WHERE tag = ?",
      )
      .get(tag) as { n: number; c: number };
    const emb = this.deps.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) c FROM embedding_calls WHERE tag = ? AND error IS NULL")
      .get(tag) as { n: number; c: number };
    const model = sweep.conversationId
      ? (this.deps.db
          .prepare("SELECT COALESCE(SUM(cost_usd), 0) c FROM generations WHERE conversation_id = ?")
          .get(sweep.conversationId) as { c: number })
      : { c: 0 };
    const cost = {
      jevUsd: Number(jev.c),
      jevCalls: Number(jev.n),
      embeddingUsd: Number(emb.c),
      embeddingCalls: Number(emb.n),
      modelUsd: Number(model.c),
      totalUsd: Number(jev.c) + Number(emb.c) + Number(model.c),
    };
    this.deps.db
      .prepare(
        "UPDATE sweeps SET status = ?, error = ?, next_retry_at = NULL, cost_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(status, error ?? null, JSON.stringify(cost), nowIso(), id);
    if (sweep.scheduledRunId !== undefined)
      this.deps.db
        .prepare("UPDATE scheduled_runs SET status = ?, reason = COALESCE(?, reason) WHERE id = ?")
        .run(status === "failed" ? "failed" : "done", runReason(status, error), sweep.scheduledRunId);
    this.deps.log.info("sweep.finished", { sweep: id, status, error, cost });
    this.emit(this.get(id)!);
    // The next requested sweep (if any) may start now.
    queueMicrotask(() => this.pickUp());
  }

  private emit(sweep: SweepRecord): void {
    for (const l of this.listeners) {
      try {
        l(sweep);
      } catch {
        // listeners never break the sweep
      }
    }
  }
}
