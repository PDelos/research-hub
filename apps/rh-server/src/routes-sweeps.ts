// Sweeps and cards (v0.3): the Feed (cards grouped by sweep, newest first), card details with score traceability,
// sweep details with phases, counts and the cost split, and the cards-per-sweep setting.
import express, { type Router } from "express";
import type { CardDetail, CardGroup, CardView, JudgmentView, PaperMeta, SweepDetail, SweepSummary } from "@rh/sdk";
import { JudgmentInvalid } from "./feedback/feedback.ts";
import { requireAuth } from "./auth.ts";
import { int, invalid, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";
import type { ProjectRuntime } from "./project.ts";
import type { Card } from "./sweep/cards.ts";
import type { SweepRecord } from "./sweep/sweep.ts";

export function paperMeta(project: ProjectRuntime, paperId: number, withAbstract = false): PaperMeta {
  const p = project.papers.store.get(paperId);
  if (!p) return { id: paperId, title: "(removed)", authors: [] };
  return {
    id: p.id,
    title: p.title,
    authors: p.authors,
    year: p.year,
    venue: p.venue,
    server: p.server,
    link: p.ids.doi ? `https://doi.org/${p.ids.doi}` : (p.url ?? p.oaUrl),
    citations: p.citedByCount,
    ...(withAbstract ? { abstract: p.abstract } : {}),
  };
}

export function cardView(project: ProjectRuntime, card: Card): CardView {
  const question = project.charters.approved()?.charter.questions.find((q) => q.id === card.matchedQuestion);
  return {
    id: card.id,
    sweepId: card.sweepId,
    rank: card.rank,
    summary: card.summary,
    relevance: card.relevance,
    relevanceReason: card.relevanceReason,
    trust: card.trust,
    trustReason: card.trustReason,
    value: card.value,
    valueReason: card.valueReason,
    level: card.level,
    matchedQuestion: question ? { id: question.id, text: question.text } : undefined,
    borderline: card.borderline,
    createdAt: card.createdAt,
    paper: paperMeta(project, card.paperId),
    judgment: judgmentView(project, card.id),
  };
}

function judgmentView(project: ProjectRuntime, cardId: number): JudgmentView | null {
  const j = project.feedback.get(cardId);
  return j ? { verdict: j.verdict, reason: j.reason, reasonKind: j.reasonKind, ruleStatus: j.ruleStatus, updatedAt: j.updatedAt } : null;
}

function cardDetail(project: ProjectRuntime, card: Card): CardDetail {
  return {
    ...cardView(project, card),
    paper: paperMeta(project, card.paperId, true),
    details: card.details,
    weightEffects: project.feedback.effects(card.id),
  };
}

export function sweepSummary(project: ProjectRuntime, s: SweepRecord): SweepSummary {
  const cards = Number((project.db.prepare("SELECT COUNT(*) n FROM cards WHERE sweep_id = ?").get(s.id) as { n: number }).n);
  return {
    id: s.id,
    trigger: s.trigger,
    status: s.status,
    phase: s.phase,
    orientation: s.orientation,
    counts: s.counts,
    error: s.error,
    nextRetryAt: s.nextRetryAt,
    cost: s.cost,
    cards,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

export function sweepRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const p = () => hub.project;

  r.get("/v1/cards", (req, res) => {
    const project = p();
    const groups: CardGroup[] = [];
    for (const card of project.cards.list(Math.min(int(req.query.limit, "limit", 100), 500))) {
      let group = groups.at(-1);
      if (!group || group.sweep.id !== card.sweepId) {
        group = { sweep: sweepSummary(project, project.sweeps.get(card.sweepId)!), cards: [] };
        groups.push(group);
      }
      group.cards.push(cardView(project, card));
    }
    res.json({ groups });
  });

  r.get("/v1/cards/:id", (req, res) => {
    const project = p();
    const card = project.cards.get(int(req.params.id, "id"));
    if (!card) throw notFound(`No card ${req.params.id}`);
    res.json(cardDetail(project, card));
  });

  r.put("/v1/cards/:id/judgment", (req, res) => {
    const project = p();
    const card = project.cards.get(int(req.params.id, "id"));
    if (!card) throw notFound(`No card ${req.params.id}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      project.feedback.judge(card.id, body.verdict, body.reason);
    } catch (error) {
      if (error instanceof JudgmentInvalid) throw invalid(error.message);
      throw error;
    }
    res.json(cardDetail(project, card));
  });

  r.delete("/v1/cards/:id/judgment", (req, res) => {
    const project = p();
    const card = project.cards.get(int(req.params.id, "id"));
    if (!card) throw notFound(`No card ${req.params.id}`);
    project.feedback.clear(card.id);
    res.json(cardDetail(project, card));
  });

  r.get("/v1/feedback/precision", (_req, res) => void res.json(p().feedback.precision()));
  r.get("/v1/weights", (_req, res) => void res.json(p().feedback.weights()));

  r.get("/v1/sweeps", (req, res) => {
    const project = p();
    res.json(project.sweeps.list(Math.min(int(req.query.limit, "limit", 50), 200)).map((s) => sweepSummary(project, s)));
  });

  r.get("/v1/sweeps/:id", (req, res) => {
    const project = p();
    const sweep = project.sweeps.get(int(req.params.id, "id"));
    if (!sweep) throw notFound(`No sweep ${req.params.id}`);
    const detail: SweepDetail = {
      ...sweepSummary(project, sweep),
      queries: sweep.queries,
      windowSince: sweep.windowSince,
      phases: sweep.phases,
      completion: sweep.completion,
      papers: project.sweeps.papers(sweep.id).map((sp) => ({
        paperId: sp.paperId,
        title: project.papers.store.get(sp.paperId)?.title ?? "(removed)",
        status: sp.status,
        reason: sp.reason,
        borderline: sp.borderline,
        relevance: sp.relevance,
        level: sp.level,
        kind: sp.kind,
        rank: sp.rank,
        rankScore: sp.rankScore,
      })),
    };
    res.json(detail);
  });

  r.get("/v1/sweep-settings", (_req, res) => void res.json({ cardsPerSweep: p().sweeps.cardsPerSweep() }));

  r.put("/v1/sweep-settings", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.cardsPerSweep !== undefined) {
      try {
        p().sweeps.setCardsPerSweep(body.cardsPerSweep);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : String(error));
      }
    }
    res.json({ cardsPerSweep: p().sweeps.cardsPerSweep() });
  });

  return r;
}
