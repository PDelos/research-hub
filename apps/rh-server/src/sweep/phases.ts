// The sweep's phases before the cards (spec paper-sweep; design D1, D3, D7): plan the queries, gather papers, drop
// those already seen, gate them with Jev, enrich and represent them, level them, then rank the candidates. Each phase
// returns its counts; the runner records them and moves the phase pointer.
import type { Charter } from "../charter.ts";
import type { Paper } from "../papers/store.ts";
import { GATE, RANKING } from "./decisions.ts";
import {
  choiceOf,
  DEFAULT_RANK_WEIGHTS,
  freshness,
  gateVars,
  levelFit,
  levelFrom,
  noulOf,
  planQueries,
  questionWeight,
  rankScore,
  scoreOf,
  type Level,
} from "./policy.ts";
import type { Phase, SweepDeps, SweepRecord } from "./sweep.ts";

export const ORIENTATION_JUDGED = 10;
export const RESULTS_PER_SOURCE = 10;
const GATE_CHUNK = 10;
const GATE_PARALLEL = 5;

/** What the phases need from the runner. */
export interface PhaseHooks {
  now(): number;
  cardsPerSweep(): number;
  setDetail(id: number, phase: Phase, detail: unknown): void;
  /** A rank with no candidates ends the sweep. */
  noNewPapers(id: number): void;
}
/** Run `work` over items in `n` parallel lanes; every lane finishes its items, then the first failure is thrown. */
async function lanes<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async (_, lane) => {
      for (let k = lane; k < items.length; k += concurrency) await work(items[k]);
    }),
  );
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
}

export class SweepPhases {
  constructor(
    private readonly deps: SweepDeps,
    private readonly hooks: PhaseHooks,
  ) {}

  /** Run one phase (the cards phase belongs to the card writer). */
  run(phase: Phase, sweep: SweepRecord): Promise<Record<string, number>> | Record<string, number> {
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

  private now(): number {
    return this.hooks.now();
  }

  /** The approved charter with effective weights (the user's judgments nudge question and query weights). */
  charter(): Charter {
    const approved = this.deps.charters.approved();
    if (!approved) throw new Error("the project has no approved charter");
    const weight = this.deps.weight;
    if (!weight) return approved.charter;
    return {
      ...approved.charter,
      questions: approved.charter.questions.map((q) => ({ ...q, weight: weight("question", q.id, q.weight) })),
      queries: approved.charter.queries.map((q) => ({ ...q, weight: weight("query", q.text, q.weight) })),
    };
  }

  /** Average effective weight of a paper's sources (1 when untouched). */
  private sourceWeight(paper: Paper): number {
    const weight = this.deps.weight;
    if (!weight || !paper.sources.length) return 1;
    return paper.sources.reduce((sum, s) => sum + weight("source", s, 1), 0) / paper.sources.length;
  }

  private plan(sweep: SweepRecord): Record<string, number> {
    const charter = this.charter();
    const orientation = (this.deps.judged?.() ?? 0) < ORIENTATION_JUDGED;
    const queries = planQueries(charter, orientation, this.deps.random ?? Math.random);
    let since: string | null = null;
    if (!orientation) {
      const previous = this.deps.db
        .prepare(
          "SELECT started_at FROM sweeps WHERE id < ? AND status IN ('completed', 'no_new_papers') ORDER BY id DESC LIMIT 1",
        )
        .get(sweep.id) as { started_at: string } | undefined;
      since = (previous?.started_at ?? new Date(this.now() - 7 * 86_400_000).toISOString()).slice(0, 10);
    }
    this.deps.db
      .prepare("UPDATE sweeps SET orientation = ?, queries_json = ?, window_since = ? WHERE id = ?")
      .run(orientation ? 1 : 0, JSON.stringify(queries), since, sweep.id);
    return { queries: queries.length, variants: queries.filter((q) => q.variant).length };
  }

  private async gather(sweep: SweepRecord): Promise<Record<string, number>> {
    const insert = this.deps.db.prepare(
      "INSERT OR IGNORE INTO sweep_papers (sweep_id, paper_id, status) VALUES (?, ?, 'new')",
    );
    const foundBy = new Map<number, Set<string>>();
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
        const base = q.variant ? q.text.replace(/ review$/, "") : q.text;
        for (const p of result.papers) {
          insert.run(sweep.id, p.id);
          foundBy.set(p.id, (foundBy.get(p.id) ?? new Set<string>()).add(base));
        }
        detail.push({ query: q.text, found: result.papers.length, failed });
      } catch (error) {
        failedQueries++;
        detail.push({ query: q.text, found: 0, failed: [error instanceof Error ? error.message : String(error)] });
      }
    }
    // The charter queries that found each paper (review variants count for their base query), for weight nudges.
    const setQueries = this.deps.db.prepare(
      "UPDATE sweep_papers SET queries_json = ? WHERE sweep_id = ? AND paper_id = ?",
    );
    for (const [paperId, queries] of foundBy) setQueries.run(JSON.stringify([...queries]), sweep.id, paperId);
    this.hooks.setDetail(sweep.id, "gather", detail);
    if (sweep.queries.length && failedQueries === sweep.queries.length)
      throw new Error(`every query failed: ${detail[0]?.failed.join("; ") || "no source answered"}`);
    return { gathered: this.count(sweep.id), failedQueries };
  }

  private dedupe(sweep: SweepRecord): Record<string, number> {
    const rows = this.deps.db
      .prepare("SELECT paper_id FROM sweep_papers WHERE sweep_id = ? AND status = 'new'")
      .all(sweep.id) as {
      paper_id: number;
    }[];
    const seen = this.deps.db.prepare(
      `SELECT EXISTS (SELECT 1 FROM cards WHERE paper_id = :p)
           OR EXISTS (SELECT 1 FROM sweep_papers WHERE paper_id = :p AND sweep_id != :s AND status = 'rejected') AS seen`,
    );
    const drop = this.deps.db.prepare("DELETE FROM sweep_papers WHERE sweep_id = ? AND paper_id = ?");
    let dropped = 0;
    for (const { paper_id } of rows) {
      const isSeen =
        (seen.get({ p: paper_id, s: sweep.id }) as { seen: number }).seen || this.deps.judgedPaper?.(Number(paper_id));
      if (isSeen) {
        drop.run(sweep.id, paper_id);
        dropped++;
      }
    }
    return { new: rows.length - dropped, dropped };
  }

  private async gate(sweep: SweepRecord): Promise<Record<string, number>> {
    const charter = this.charter();
    const onTheme = this.deps.decisions.command("on-theme").policy as {
      relevance_min: number;
      review_band: [number, number];
    };
    const worthPolicy = { ...(this.deps.decisions.command("worth-reading").policy as { worth_min: number }) };
    const knobs = this.deps.knobs?.() ?? {};
    const relevanceMin = knobs.relevanceMin ?? onTheme.relevance_min;
    if (knobs.worthMin !== undefined) worthPolicy.worth_min = knobs.worthMin;
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
      if (relevance < relevanceMin) {
        status = "rejected";
        reason = `below relevance_min ${relevanceMin} (relevance ${relevance.toFixed(2)})`;
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
    for (let i = 0; i < pending.length; i += GATE_CHUNK * GATE_PARALLEL)
      await lanes(pending.slice(i, i + GATE_CHUNK * GATE_PARALLEL), GATE_PARALLEL, judge);
    return {
      gated: this.idsWith(sweep.id, "gated").length,
      rejected: this.idsWith(sweep.id, "rejected").length,
      borderline: Number(
        (
          this.deps.db
            .prepare("SELECT COUNT(*) n FROM sweep_papers WHERE sweep_id = ? AND borderline = 1")
            .get(sweep.id) as { n: number }
        ).n,
      ),
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
      this.deps.db
        .prepare("SELECT paper_id FROM sweep_papers WHERE sweep_id = ? AND status = 'gated' AND level IS NULL")
        .all(sweep.id) as {
        paper_id: number;
      }[]
    ).map((r) => Number(r.paper_id));
    const update = this.deps.db.prepare(
      "UPDATE sweep_papers SET level = ?, prereq_heavy = ?, importance = ? WHERE sweep_id = ? AND paper_id = ?",
    );
    await lanes(ids, GATE_PARALLEL, async (id) => {
      const paper = this.deps.papers.store.get(id)!;
      const row = this.deps.db
        .prepare("SELECT kind FROM sweep_papers WHERE sweep_id = ? AND paper_id = ?")
        .get(sweep.id, id) as { kind: string | null };
      const answers = await this.deps.decisions.decide(id, RANKING, {
        ...gateVars(paper, charter),
        kind: row.kind ?? "unknown",
        year: paper.year ?? "unknown",
        venue: paper.venue ?? paper.server ?? "unknown",
        citations: paper.citedByCount ?? "unknown",
        stage: sweep.orientation
          ? "new to the field: needs foundations and overviews first"
          : "familiar with the field: wants important new work",
      });
      update.run(
        levelFrom(answers.level.level),
        noulOf(answers.level.prereq_heavy),
        scoreOf(answers.importance.importance),
        sweep.id,
        id,
      );
    });
    return { leveled: this.idsWith(sweep.id, "gated").length };
  }

  private rank(sweep: SweepRecord): Record<string, number> {
    const charter = this.charter();
    const cards = this.hooks.cardsPerSweep();
    const rows = this.deps.db
      .prepare(
        "SELECT paper_id, matched_question, level, importance, relevance FROM sweep_papers WHERE sweep_id = ? AND status = 'gated'",
      )
      .all(sweep.id) as {
      paper_id: number;
      matched_question: string | null;
      level: Level;
      importance: number;
      relevance: number;
    }[];
    const now = this.now();
    const weights = this.deps.knobs?.().rankWeights ?? DEFAULT_RANK_WEIGHTS;
    const target = this.deps.knobs?.().level ?? "auto";
    const scored: { id: number; score: number }[] = [];
    let blocked = 0;
    const set = this.deps.db.prepare(
      "UPDATE sweep_papers SET status = ?, reason = ?, rank_score = ?, rank = ? WHERE sweep_id = ? AND paper_id = ?",
    );
    for (const r of rows) {
      const paper = this.deps.papers.store.get(Number(r.paper_id))!;
      const score =
        rankScore(
          {
            importance: r.importance ?? 0,
            relevance: r.relevance ?? 0,
            questionWeight: questionWeight(charter, r.matched_question ?? undefined),
            levelFit: levelFit(r.level ?? "core", sweep.orientation, target),
            freshness: sweep.orientation ? 0.5 : freshness(paper.publishedAt, now),
          },
          weights,
        ) +
        0.05 * (this.sourceWeight(paper) - 1);
      if (paper.retracted) {
        set.run("blocked", "retracted", score, null, sweep.id, r.paper_id);
        this.deps.log.info("sweep.blocked_retracted", { sweep: sweep.id, paperId: r.paper_id, title: paper.title });
        blocked++;
        continue;
      }
      scored.push({ id: Number(r.paper_id), score });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    // Exploration picks take the last card slots; the rest keep their rank order.
    const picks = new Set(
      this.deps.explore?.({ sweepId: sweep.id, ranked: scored.map((s) => s.id), slots: cards }) ?? [],
    );
    const top = scored.filter((s) => !picks.has(s.id)).slice(0, Math.max(0, cards - picks.size));
    const chosen = [...top, ...scored.filter((s) => picks.has(s.id))];
    const chosenIds = new Set(chosen.map((s) => s.id));
    [...chosen, ...scored.filter((s) => !chosenIds.has(s.id))].forEach((s, i) =>
      set.run(i < chosen.length ? "candidate" : "ranked_out", null, s.score, i + 1, sweep.id, s.id),
    );
    const candidates = chosen.length;
    if (!candidates) {
      this.hooks.noNewPapers(sweep.id);
      return { candidates: 0, rankedOut: 0, blocked };
    }
    return { candidates, rankedOut: scored.length - candidates, blocked };
  }

  private idsWith(sweepId: number, status: string): number[] {
    return (
      this.deps.db
        .prepare("SELECT paper_id FROM sweep_papers WHERE sweep_id = ? AND status = ? ORDER BY paper_id")
        .all(sweepId, status) as {
        paper_id: number;
      }[]
    ).map((r) => Number(r.paper_id));
  }

  private count(sweepId: number): number {
    return Number(
      (this.deps.db.prepare("SELECT COUNT(*) n FROM sweep_papers WHERE sweep_id = ?").get(sweepId) as { n: number }).n,
    );
  }
}
