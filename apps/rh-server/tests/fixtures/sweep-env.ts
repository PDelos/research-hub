// A sweep test environment: project database, approved charter, PaperService (fake fetch or synthetic offline
// sources), scripted Jev, and a SweepRunner with fast retries and a fake card stage.
import { join } from "node:path";
import { JevLedger } from "@rh/jev";
import { Charters, validateCharter } from "../../src/charter.ts";
import { openProjectDb, Settings } from "../../src/db.ts";
import { createLogger } from "../../src/logger.ts";
import { PaperService } from "../../src/papers/service.ts";
import { PaperDecisions } from "../../src/sweep/decisions.ts";
import { SweepRunner, type CardStage, type SweepDeps } from "../../src/sweep/sweep.ts";
import { CardStore } from "../../src/sweep/cards.ts";
import { Feedback } from "../../src/feedback/feedback.ts";
import { ReasonParser } from "../../src/feedback/reasons.ts";
import { Telemetry } from "../../src/telemetry.ts";
import { tempDir } from "../helpers.ts";
import { sampleCharter } from "./charter.ts";
import { scripted, type Script } from "./jev-answers.ts";

export const JEV_DIR = join(import.meta.dirname, "../../prompt_engineering/jev");

export interface SweepEnvOptions {
  script?: Script;
  fetch?: typeof fetch;
  dir?: string;
  runner?: Partial<SweepDeps>;
  /** Card stage: default presents nothing and completes at once. */
  cards?: (runner: SweepRunner) => CardStage;
  charter?: Record<string, unknown>;
}

export function sweepEnv(options: SweepEnvOptions = {}) {
  const t = options.dir ? { dir: options.dir, cleanup: () => {} } : tempDir();
  const { db } = openProjectDb(join(t.dir, "project.sqlite"));
  const settings = new Settings(db);
  const telemetry = new Telemetry(db);
  const logs: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => logs.push(l) });
  const charters = new Charters(db);
  if (!charters.approved()) {
    charters.saveDraft(validateCharter(options.charter ?? sampleCharter()), "user");
    charters.approve();
  }
  const jev = scripted(options.script ?? (() => undefined));
  const ledger = new JevLedger((r) => telemetry.jevCall(r));
  const papers = new PaperService({
    db,
    settings,
    config: { embedModel: "offline/fake-embedding", embedDims: 64 },
    offline: true,
    jevDir: JEV_DIR,
    decide: jev.decide,
    jevLedger: ledger,
    log,
    fetch: options.fetch,
  });
  const feedback = new Feedback({ db, charters, log });
  feedback.replay();
  const decisions = new PaperDecisions({
    db,
    jevDir: JEV_DIR,
    decide: jev.decide,
    ledger,
    taste: () =>
      feedback
        .recent(8)
        .map((j) => ({ title: j.title, verdict: j.verdict, ...(j.reason ? { reason: j.reason.slice(0, 200) } : {}) })),
  });
  const reasons = new ReasonParser({ db, jevDir: JEV_DIR, decide: jev.decide, ledger, log });
  const runner = new SweepRunner({
    db,
    settings,
    charters,
    papers,
    decisions,
    log,
    retryDelaysMs: [0, 0, 0],
    random: seeded(7),
    judged: () => feedback.count(),
    judgedPaper: (id) => feedback.isJudged(id),
    weight: (kind, key, fallback) => feedback.weight(kind, key, fallback),
    ...options.runner,
  });
  const cards = new CardStore(db);
  const cardCalls: number[] = [];
  runner.setCardStage(
    options.cards?.(runner) ?? {
      start: async (sweep) => {
        cardCalls.push(sweep.id);
        runner.cardsSettled(sweep.id, { ok: true });
      },
      resume: () => {},
    },
  );
  return {
    db,
    settings,
    charters,
    papers,
    decisions,
    runner,
    jev,
    logs,
    cardCalls,
    dir: t.dir,
    feedback,
    cards,
    reasons,
    /** Turn a sweep's candidates into cards with fixed scores (no agent). */
    presentAll(sweepId: number) {
      const out = [];
      for (const sp of runner.papers(sweepId).filter((p) => p.status === "candidate")) {
        const { card } = cards.create({
          paperId: sp.paperId,
          sweepId,
          rank: sp.rank,
          summary: "A summary.",
          scores: {
            relevance: 70,
            relevanceReason: "r",
            trust: 60,
            trustReason: "t",
            value: 50,
            valueReason: "v",
            level: sp.level ?? "core",
            matchedQuestion: sp.matchedQuestion,
            borderline: sp.borderline,
            details: { decisions: {}, inputs: {}, formulas: {} },
          },
        });
        out.push(card);
      }
      return out;
    },
    async done() {
      await runner.close();
      await papers.close();
      db.close();
      t.cleanup();
    },
    async close() {
      await runner.close();
      await papers.close();
      db.close();
    },
  };
}

/** A small deterministic PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakePaper {
  id: string;
  title: string;
  abstract: string;
  date?: string;
}

/** An arXiv Atom feed with these papers. */
export function arxivFeed(papers: FakePaper[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${papers
    .map(
      (p) =>
        `<entry><id>http://arxiv.org/abs/${p.id}v1</id><title>${esc(p.title)}</title><summary>${esc(p.abstract)}</summary><published>${p.date ?? "2026-10-01"}T00:00:00Z</published><author><name>A. Author</name></author><arxiv:primary_category term="cs.LG"/></entry>`,
    )
    .join("")}</feed>`;
}

/** Fetch where arXiv returns `papers` for every query, the other sources nothing, and OpenAlex lookups `works`. */
export function arxivOnlyFetch(
  papers: FakePaper[],
  works: (doi: string) => Record<string, unknown> | undefined = () => undefined,
): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.host === "export.arxiv.org") return new Response(arxivFeed(papers));
    if (url.host === "api.openalex.org" && url.searchParams.get("filter")?.startsWith("doi:"))
      return Response.json({ results: url.searchParams.get("filter")!.slice(4).split("|").map(works).filter(Boolean) });
    if (url.host === "api.openalex.org") return Response.json({ results: [] });
    if (url.host === "www.ebi.ac.uk") return Response.json({ resultList: { result: [] } });
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

export const fakePapers = (n: number, prefix = "Paper"): FakePaper[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `2610.${String(10000 + i)}`,
    title: `${prefix} ${i + 1} on protein language models`,
    abstract: `Protein language models need better contact maps. We propose method ${i + 1}. Accuracy improves by ${i + 1}%.`,
  }));
