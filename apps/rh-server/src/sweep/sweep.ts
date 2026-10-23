// The daily sweep (spec paper-sweep; design D1, D3, D7): plan → gather → dedupe → gate → enrich → level → rank, then
// the card writer. Every phase commits its results before the phase pointer moves, and Jev answers are stored per
// paper (PaperDecisions), so a sweep resumes after a crash without paying twice. A failing phase retries after
// 30 s, 2 min and 8 min, then the sweep fails with the error.
import { normalized, type Answer, type ChoiceAnswer, type ScoreAnswer } from "@rh/jev";
import type { Charter, CharterQuestion, Charters } from "../charter.ts";
import { withCostTag } from "../cost-tag.ts";
import { nowIso, type Db, type Settings } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { PaperService } from "../papers/service.ts";
import type { Paper } from "../papers/store.ts";
import { clip, GATE, PaperDecisions, RANKING } from "./decisions.ts";

export const PHASES = ["plan", "gather", "dedupe", "gate", "enrich", "level", "rank", "cards"] as const;
export type Phase = (typeof PHASES)[number];
export type SweepStatus = "running" | "completed" | "no_new_papers" | "failed";
export const LEVELS = ["foundational", "core", "advanced", "frontier"] as const;
export type Level = (typeof LEVELS)[number];

export const MAX_QUERIES = 15;
export const ORIENTATION_VARIANTS = 5;
export const ORIENTATION_JUDGED = 10;
export const RESULTS_PER_SOURCE = 10;
export const DEFAULT_RETRY_DELAYS = [30_000, 120_000, 480_000];
export const CARDS_PER_SWEEP = { default: 7, min: 1, max: 15 };
const GATE_CHUNK = 10;
const GATE_PARALLEL = 5;

export interface PlannedQuery {
  text: string;
  weight: number;
  variant?: "review";
}

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
  cost?: { jevUsd: number; jevCalls: number; embeddingUsd: number; embeddingCalls: number; modelUsd: number; totalUsd: number };
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
  now?: () => number;
  random?: () => number;
  retryDelaysMs?: number[];
}

// ---------------------------------------------------------------- plan

/**
 * Weighted draw without replacement (Efraimidis–Spirakis): each query gets the key u^(1/w) and the `max` largest
 * keys win, so a higher weight is drawn more often and every query with a positive weight can be drawn.
 */
export function drawQueries(queries: { text: string; weight: number }[], max: number, random: () => number): PlannedQuery[] {
  return queries
    .filter((q) => q.weight > 0)
    .map((q) => ({ q, key: Math.pow(Math.max(random(), Number.MIN_VALUE), 1 / q.weight) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, max)
    .map(({ q }) => ({ text: q.text, weight: q.weight }));
}

export function planQueries(charter: Charter, orientation: boolean, random: () => number): PlannedQuery[] {
  const drawn = drawQueries(charter.queries, MAX_QUERIES, random);
  if (!orientation) return drawn;
  const variants = drawn.slice(0, ORIENTATION_VARIANTS).map((q) => ({ text: `${q.text} review`, weight: q.weight, variant: "review" as const }));
  return [...drawn, ...variants];
}

// ---------------------------------------------------------------- scoring helpers

const scoreOf = (a: Answer | undefined): number => (a && a.type === "score" ? normalized(a as ScoreAnswer) : 0);
const noulOf = (a: Answer | undefined): number => (a && a.type === "noul" ? a.noul : 0);
const choiceOf = (a: Answer | undefined): string | undefined => (a && a.type === "choice" ? (a as ChoiceAnswer).choice : undefined);

export function levelFrom(answer: Answer | undefined): Level {
  return LEVELS[Math.min(3, Math.max(0, Math.round(scoreOf(answer) * 3)))];
}

export function levelFit(level: Level, orientation: boolean): number {
  const fit = orientation
    ? { foundational: 1, core: 0.8, advanced: 0.4, frontier: 0.2 }
    : { foundational: 0.6, core: 1, advanced: 0.9, frontier: 0.8 };
  return fit[level];
}

export function freshness(publishedAt: string | undefined, now: number): number {
  if (!publishedAt) return 0.5;
  const days = Math.max(0, (now - Date.parse(publishedAt)) / 86_400_000);
  return Math.exp(-days / 365);
}

export function questionWeight(charter: Charter, matched: string | undefined): number {
  return charter.questions.find((q) => q.id === matched)?.weight ?? 0.5;
}

// ---------------------------------------------------------------- runner

export class SweepRunner {
  private cards?: CardStage;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly driving = new Set<number>();
  private closed = false;
  private readonly listeners = new Set<(sweep: SweepRecord) => void>();

  constructor(private readonly deps: SweepDeps) {}

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
    return this.deps.settings.get("cards_per_sweep", CARDS_PER_SWEEP.default);
  }

  setCardsPerSweep(n: unknown): number {
    if (typeof n !== "number" || !Number.isInteger(n) || n < CARDS_PER_SWEEP.min || n > CARDS_PER_SWEEP.max)
      throw new RangeError(`cards_per_sweep must be a whole number from ${CARDS_PER_SWEEP.min} to ${CARDS_PER_SWEEP.max}`);
    this.deps.settings.set("cards_per_sweep", n);
    return n;
  }

  get(id: number): SweepRecord | undefined {
    const row = this.deps.db.prepare("SELECT * FROM sweeps WHERE id = ?").get(id) as SweepRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(limit = 50): SweepRecord[] {
    return (this.deps.db.prepare("SELECT * FROM sweeps ORDER BY id DESC LIMIT ?").all(limit) as unknown as SweepRow[]).map(toRecord);
  }

  running(): SweepRecord | undefined {
    const row = this.deps.db.prepare("SELECT * FROM sweeps WHERE status = 'running' ORDER BY id LIMIT 1").get() as SweepRow | undefined;
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
    for (const sweep of (this.deps.db.prepare("SELECT * FROM sweeps WHERE status = 'running'").all() as unknown as SweepRow[]).map(toRecord)) {
      if (sweep.phase === "cards") this.cards?.resume(sweep);
      else this.schedule(sweep);
    }
    if (this.running()) return;
    const requested = this.deps.db
      .prepare("SELECT id, trigger FROM scheduled_runs WHERE kind = 'sweep' AND status = 'requested' ORDER BY id LIMIT 1")
      .get() as { id: number; trigger: string } | undefined;
    if (requested) this.start(requested.trigger, Number(requested.id));
  }

  /** Start a sweep now (a claimed scheduled run, or directly in tests). */
  start(trigger: string, scheduledRunId?: number): SweepRecord {
    const existing = this.running();
    if (existing) return existing;
    const result = this.deps.db
      .prepare("INSERT INTO sweeps (scheduled_run_id, trigger, status, phase, started_at) VALUES (?, ?, 'running', 'plan', ?)")
      .run(scheduledRunId ?? null, trigger, nowIso());
    const id = Number(result.lastInsertRowid);
    if (scheduledRunId !== undefined) this.deps.db.prepare("UPDATE scheduled_runs SET status = 'running' WHERE id = ?").run(scheduledRunId);
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
            const counts = await this.runPhase(phase, sweep);
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
      this.deps.log.error("sweep.drive_failed", { sweep: id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.driving.delete(id);
    }
    if (retry) this.schedule(this.get(id)!);
  }

  private async runPhase(phase: Phase, sweep: SweepRecord): Promise<Record<string, number>> {
    switch (phase) {
      case "plan":
        return this.plan(sweep);
      case "gather":
        return this.gather(sweep);
      case "dedupe":
        return this.dedupe(sweep);
      case "gate":
        return this.gate(sweep);
      case "enrich":
        return this.enrich(sweep);
      case "level":
        return this.level(sweep);
      case "rank":
        return this.rank(sweep);
      default:
        throw new Error(`unknown phase ${phase}`);
    }
  }

  // ---- phases

  private charter(): Charter {
    const approved = this.deps.charters.approved();
    if (!approved) throw new Error("the project has no approved charter");
    return approved.charter;
  }

  private plan(sweep: SweepRecord): Record<string, number> {
    const charter = this.charter();
    const orientation = (this.deps.judged?.() ?? 0) < ORIENTATION_JUDGED;
    const queries = planQueries(charter, orientation, this.deps.random ?? Math.random);
    let since: string | null = null;
    if (!orientation) {
      const previous = this.deps.db
        .prepare("SELECT started_at FROM sweeps WHERE id < ? AND status IN ('completed', 'no_new_papers') ORDER BY id DESC LIMIT 1")
        .get(sweep.id) as { started_at: string } | undefined;
      since = (previous?.started_at ?? new Date(this.now() - 7 * 86_400_000).toISOString()).slice(0, 10);
    }
    this.deps.db
      .prepare("UPDATE sweeps SET orientation = ?, queries_json = ?, window_since = ? WHERE id = ?")
      .run(orientation ? 1 : 0, JSON.stringify(queries), since, sweep.id);
    return { queries: queries.length, variants: queries.filter((q) => q.variant).length };
  }

  private async gather(sweep: SweepRecord): Promise<Record<string, number>> {
    const insert = this.deps.db.prepare("INSERT OR IGNORE INTO sweep_papers (sweep_id, paper_id, status) VALUES (?, ?, 'new')");
    const detail: { query: string; found: number; failed: string[] }[] = [];
    let failedQueries = 0;
    for (const q of sweep.queries) {
      try {
        const result = await this.deps.papers.search.search({
          query: q.text,
          since: sweep.windowSince,
          limit: 100,
          perSource: RESULTS_PER_SOURCE,
          enrich: false,
        });
        const failed = result.sources.filter((s) => s.status === "failed").map((s) => `${s.source}: ${s.error}`);
        if (result.sources.every((s) => s.status !== "ok")) failedQueries++;
        for (const p of result.papers) insert.run(sweep.id, p.id);
        detail.push({ query: q.text, found: result.papers.length, failed });
      } catch (error) {
        failedQueries++;
        detail.push({ query: q.text, found: 0, failed: [error instanceof Error ? error.message : String(error)] });
      }
    }
    this.setDetail(sweep.id, "gather", detail);
    if (sweep.queries.length && failedQueries === sweep.queries.length)
      throw new Error(`every query failed: ${detail[0]?.failed.join("; ") || "no source answered"}`);
    return { gathered: this.count(sweep.id), failedQueries };
  }

  private dedupe(sweep: SweepRecord): Record<string, number> {
    const rows = this.deps.db.prepare("SELECT paper_id FROM sweep_papers WHERE sweep_id = ? AND status = 'new'").all(sweep.id) as {
      paper_id: number;
    }[];
    const seen = this.deps.db.prepare(
      `SELECT EXISTS (SELECT 1 FROM cards WHERE paper_id = :p)
           OR EXISTS (SELECT 1 FROM sweep_papers WHERE paper_id = :p AND sweep_id != :s AND status = 'rejected') AS seen`,
    );
    const drop = this.deps.db.prepare("DELETE FROM sweep_papers WHERE sweep_id = ? AND paper_id = ?");
    let dropped = 0;
    for (const { paper_id } of rows) {
      const isSeen = (seen.get({ p: paper_id, s: sweep.id }) as { seen: number }).seen || this.deps.judgedPaper?.(Number(paper_id));
      if (isSeen) {
        drop.run(sweep.id, paper_id);
        dropped++;
      }
    }
    return { new: rows.length - dropped, dropped };
  }

  private async gate(sweep: SweepRecord): Promise<Record<string, number>> {
    const charter = this.charter();
    const onTheme = this.deps.decisions.command("on-theme").policy as { relevance_min: number; review_band: [number, number] };
    const worthPolicy = this.deps.decisions.command("worth-reading").policy as { worth_min: number };
    const pending = this.idsWith(sweep.id, "new");
    const update = this.deps.db.prepare(
      `UPDATE sweep_papers SET status = :status, reason = :reason, borderline = :borderline, relevance = :relevance,
         matched_question = :matched, kind = :kind, worth = :worth, novelty = :novelty WHERE sweep_id = :sweep AND paper_id = :paper`,
    );
    const judge = async (paperId: number) => {
      const paper = this.deps.papers.store.get(paperId)!;
      const answers = await this.deps.decisions.decide(paperId, GATE, gateVars(paper, charter));
      const relevance = scoreOf(answers["on-theme"].relevance);
      const worth = noulOf(answers["worth-reading"].worth);
      let status = "gated";
      let reason: string | null = null;
      if (relevance < onTheme.relevance_min) {
        status = "rejected";
        reason = `below relevance_min ${onTheme.relevance_min} (relevance ${relevance.toFixed(2)})`;
      } else if (worth < worthPolicy.worth_min) {
        status = "rejected";
        reason = `below worth_min ${worthPolicy.worth_min} (worth ${worth.toFixed(2)})`;
      }
      const [low, high] = onTheme.review_band;
      update.run({
        status,
        reason,
        borderline: status === "gated" && relevance >= low && relevance < high ? 1 : 0,
        relevance,
        matched: choiceOf(answers["on-theme"].matched_question) ?? null,
        kind: choiceOf(answers["paper-kind"].kind) ?? null,
        worth,
        novelty: scoreOf(answers["worth-reading"].novelty),
        sweep: sweep.id,
        paper: paperId,
      });
    };
    for (let i = 0; i < pending.length; i += GATE_CHUNK * GATE_PARALLEL) {
      const batch = pending.slice(i, i + GATE_CHUNK * GATE_PARALLEL);
      const lanes = Array.from({ length: GATE_PARALLEL }, (_, lane) => batch.filter((_, k) => k % GATE_PARALLEL === lane));
      const results = await Promise.allSettled(lanes.map(async (lane) => {
        for (const id of lane) await judge(id);
      }));
      const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failure) throw failure.reason;
    }
    return {
      gated: this.idsWith(sweep.id, "gated").length,
      rejected: this.idsWith(sweep.id, "rejected").length,
      borderline: Number((this.deps.db.prepare("SELECT COUNT(*) n FROM sweep_papers WHERE sweep_id = ? AND borderline = 1").get(sweep.id) as { n: number }).n),
    };
  }

  private async enrich(sweep: SweepRecord): Promise<Record<string, number>> {
    const ids = this.idsWith(sweep.id, "gated");
    if (!ids.length) return { enriched: 0, represented: 0 };
    const enrichment = await this.deps.papers.search.enrich(ids);
    const represented = await this.deps.papers.vectors.represent(ids);
    return { enriched: enrichment.done, pendingEnrichment: enrichment.pending, represented: represented.represented };
  }

  private async level(sweep: SweepRecord): Promise<Record<string, number>> {
    const charter = this.charter();
    const ids = (
      this.deps.db.prepare("SELECT paper_id FROM sweep_papers WHERE sweep_id = ? AND status = 'gated' AND level IS NULL").all(sweep.id) as {
        paper_id: number;
      }[]
    ).map((r) => Number(r.paper_id));
    const update = this.deps.db.prepare(
      "UPDATE sweep_papers SET level = ?, prereq_heavy = ?, importance = ? WHERE sweep_id = ? AND paper_id = ?",
    );
    for (const id of ids) {
      const paper = this.deps.papers.store.get(id)!;
      const row = this.deps.db.prepare("SELECT kind FROM sweep_papers WHERE sweep_id = ? AND paper_id = ?").get(sweep.id, id) as { kind: string | null };
      const answers = await this.deps.decisions.decide(id, RANKING, {
        ...gateVars(paper, charter),
        kind: row.kind ?? "unknown",
        year: paper.year ?? "unknown",
        venue: paper.venue ?? paper.server ?? "unknown",
        citations: paper.citedByCount ?? "unknown",
        stage: sweep.orientation ? "new to the field: needs foundations and overviews first" : "familiar with the field: wants important new work",
      });
      update.run(levelFrom(answers.level.level), noulOf(answers.level.prereq_heavy), scoreOf(answers.importance.importance), sweep.id, id);
    }
    return { leveled: this.idsWith(sweep.id, "gated").length };
  }

  private rank(sweep: SweepRecord): Record<string, number> {
    const charter = this.charter();
    const n = this.cardsPerSweep();
    const rows = this.deps.db
      .prepare("SELECT paper_id, matched_question, level, importance FROM sweep_papers WHERE sweep_id = ? AND status = 'gated'")
      .all(sweep.id) as { paper_id: number; matched_question: string | null; level: Level; importance: number }[];
    const now = this.now();
    const scored: { id: number; score: number }[] = [];
    let blocked = 0;
    const set = this.deps.db.prepare("UPDATE sweep_papers SET status = ?, reason = ?, rank_score = ?, rank = ? WHERE sweep_id = ? AND paper_id = ?");
    for (const r of rows) {
      const paper = this.deps.papers.store.get(Number(r.paper_id))!;
      const score =
        0.5 * (r.importance ?? 0) +
        0.2 * Math.min(1, questionWeight(charter, r.matched_question ?? undefined) / 2) +
        0.2 * levelFit(r.level ?? "core", sweep.orientation) +
        0.1 * (sweep.orientation ? 0.5 : freshness(paper.publishedAt, now));
      if (paper.retracted) {
        set.run("blocked", "retracted", score, null, sweep.id, r.paper_id);
        this.deps.log.info("sweep.blocked_retracted", { sweep: sweep.id, paperId: r.paper_id, title: paper.title });
        blocked++;
        continue;
      }
      scored.push({ id: Number(r.paper_id), score });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    scored.forEach((s, i) => set.run(i < n ? "candidate" : "ranked_out", null, s.score, i + 1, sweep.id, s.id));
    const candidates = Math.min(n, scored.length);
    if (!candidates) {
      this.finish(sweep.id, "no_new_papers");
      return { candidates: 0, rankedOut: 0, blocked };
    }
    return { candidates, rankedOut: scored.length - candidates, blocked };
  }

  // ---- bookkeeping

  private idsWith(sweepId: number, status: string): number[] {
    return (
      this.deps.db.prepare("SELECT paper_id FROM sweep_papers WHERE sweep_id = ? AND status = ? ORDER BY paper_id").all(sweepId, status) as {
        paper_id: number;
      }[]
    ).map((r) => Number(r.paper_id));
  }

  private count(sweepId: number): number {
    return Number((this.deps.db.prepare("SELECT COUNT(*) n FROM sweep_papers WHERE sweep_id = ?").get(sweepId) as { n: number }).n);
  }

  private patchPhase(id: number, phase: Phase, patch: Partial<PhaseRecord>): void {
    const sweep = this.get(id)!;
    const phases = { ...sweep.phases, [phase]: { ...(sweep.phases[phase] ?? { status: "running", startedAt: nowIso(), attempts: 0 }), ...patch } };
    this.deps.db.prepare("UPDATE sweeps SET phases_json = ? WHERE id = ?").run(JSON.stringify(phases), id);
  }

  private setDetail(id: number, phase: Phase, detail: unknown): void {
    this.patchPhase(id, phase, { detail });
  }

  private phaseStarted(id: number, phase: Phase, attempt: number): void {
    const existing = this.get(id)!.phases[phase];
    this.patchPhase(id, phase, { status: "running", startedAt: existing?.startedAt ?? nowIso(), attempts: attempt, error: undefined });
    this.deps.log.info("sweep.phase_started", { sweep: id, phase, attempt });
  }

  private phaseDone(id: number, phase: Phase, counts: Record<string, number>): void {
    this.patchPhase(id, phase, { status: "done", endedAt: nowIso(), counts });
    const sweep = this.get(id)!;
    const totals = { ...sweep.counts, ...counts };
    const next = PHASES[PHASES.indexOf(phase) + 1];
    if (sweep.status === "running")
      this.deps.db.prepare("UPDATE sweeps SET phase = ?, counts_json = ?, attempts = 0, next_retry_at = NULL WHERE id = ?").run(next, JSON.stringify(totals), id);
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
    this.deps.db.prepare("UPDATE sweeps SET attempts = ?, next_retry_at = ?, error = ? WHERE id = ?").run(attempts, at, error, id);
    this.deps.log.warn("sweep.phase_failed", { sweep: id, phase, attempt: attempts, error, retryInMs: delays[attempts - 1] });
    this.emit(this.get(id)!);
    return at;
  }

  /** Card writer finished: completed when complete_sweep was recorded, failed otherwise. */
  cardsSettled(id: number, outcome: { ok: true } | { ok: false; reason: string }): void {
    const sweep = this.get(id);
    if (!sweep || sweep.status !== "running") return;
    this.patchPhase(id, "cards", { status: outcome.ok ? "done" : "failed", endedAt: nowIso(), ...(outcome.ok ? {} : { error: outcome.reason }) });
    if (outcome.ok) this.finish(id, "completed");
    else this.finish(id, "failed", outcome.reason);
  }

  /** Record the cards turn (conversation and submission) so a restart can re-attach. */
  cardsStarted(id: number, conversationId: number, submissionId: number): void {
    this.deps.db.prepare("UPDATE sweeps SET conversation_id = ?, submission_id = ? WHERE id = ?").run(conversationId, submissionId, id);
    this.patchPhase(id, "cards", { status: "running", startedAt: nowIso(), attempts: 1 });
    this.emit(this.get(id)!);
  }

  recordCompletion(id: number, completion: NonNullable<SweepRecord["completion"]>): void {
    this.deps.db.prepare("UPDATE sweeps SET completion_json = ? WHERE id = ?").run(JSON.stringify(completion), id);
  }

  private finish(id: number, status: Exclude<SweepStatus, "running">, error?: string): void {
    const sweep = this.get(id)!;
    const tag = `sweep:${id}`;
    const jev = this.deps.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) c FROM jev_calls WHERE tag = ?").get(tag) as { n: number; c: number };
    const emb = this.deps.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) c FROM embedding_calls WHERE tag = ? AND error IS NULL").get(tag) as { n: number; c: number };
    const model = sweep.conversationId
      ? (this.deps.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) c FROM generations WHERE conversation_id = ?").get(sweep.conversationId) as { c: number })
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
      .prepare("UPDATE sweeps SET status = ?, error = ?, next_retry_at = NULL, cost_json = ?, ended_at = ? WHERE id = ?")
      .run(status, error ?? null, JSON.stringify(cost), nowIso(), id);
    if (sweep.scheduledRunId !== undefined)
      this.deps.db
        .prepare("UPDATE scheduled_runs SET status = ?, reason = COALESCE(?, reason) WHERE id = ?")
        .run(status === "failed" ? "failed" : "done", status === "failed" ? error ?? null : status === "no_new_papers" ? "no new papers" : null, sweep.scheduledRunId);
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

export function gateVars(paper: Paper, charter: Charter) {
  return {
    title: paper.title,
    abstract: clip(paper.abstract) || "(no abstract)",
    questions: charter.questions.map((q: CharterQuestion) => ({ id: q.id, text: q.text })),
    question_options: { ...Object.fromEntries(charter.questions.map((q) => [q.id, q.text])), none: "None of the research questions" },
    concepts: charter.concepts,
    out_of_scope: charter.outOfScope,
  };
}

export interface SweepPaper {
  sweepId: number;
  paperId: number;
  status: string;
  reason?: string;
  borderline: boolean;
  relevance?: number;
  matchedQuestion?: string;
  kind?: string;
  worth?: number;
  novelty?: number;
  level?: Level;
  prereqHeavy?: number;
  importance?: number;
  rankScore?: number;
  rank?: number;
}

interface SweepPaperRow {
  sweep_id: number;
  paper_id: number;
  status: string;
  reason: string | null;
  borderline: number;
  relevance: number | null;
  matched_question: string | null;
  kind: string | null;
  worth: number | null;
  novelty: number | null;
  level: Level | null;
  prereq_heavy: number | null;
  importance: number | null;
  rank_score: number | null;
  rank: number | null;
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toSweepPaper(r: SweepPaperRow): SweepPaper {
  return {
    sweepId: Number(r.sweep_id),
    paperId: Number(r.paper_id),
    status: r.status,
    reason: opt(r.reason),
    borderline: !!r.borderline,
    relevance: opt(r.relevance),
    matchedQuestion: opt(r.matched_question),
    kind: opt(r.kind),
    worth: opt(r.worth),
    novelty: opt(r.novelty),
    level: opt(r.level),
    prereqHeavy: opt(r.prereq_heavy),
    importance: opt(r.importance),
    rankScore: opt(r.rank_score),
    rank: r.rank === null ? undefined : Number(r.rank),
  };
}

interface SweepRow {
  id: number;
  scheduled_run_id: number | null;
  trigger: string;
  status: SweepStatus;
  phase: Phase;
  orientation: number;
  queries_json: string;
  window_since: string | null;
  counts_json: string;
  phases_json: string;
  attempts: number;
  next_retry_at: number | null;
  error: string | null;
  conversation_id: number | null;
  submission_id: number | null;
  completion_json: string | null;
  cost_json: string | null;
  started_at: string;
  ended_at: string | null;
}

function toRecord(r: SweepRow): SweepRecord {
  return {
    id: Number(r.id),
    scheduledRunId: r.scheduled_run_id === null ? undefined : Number(r.scheduled_run_id),
    trigger: r.trigger,
    status: r.status,
    phase: r.phase,
    orientation: !!r.orientation,
    queries: JSON.parse(r.queries_json),
    windowSince: opt(r.window_since),
    counts: JSON.parse(r.counts_json),
    phases: JSON.parse(r.phases_json),
    attempts: Number(r.attempts),
    nextRetryAt: r.next_retry_at === null ? undefined : Number(r.next_retry_at),
    error: opt(r.error),
    conversationId: r.conversation_id === null ? undefined : Number(r.conversation_id),
    submissionId: r.submission_id === null ? undefined : Number(r.submission_id),
    completion: r.completion_json ? JSON.parse(r.completion_json) : undefined,
    cost: r.cost_json ? JSON.parse(r.cost_json) : undefined,
    startedAt: r.started_at,
    endedAt: opt(r.ended_at),
  };
}
