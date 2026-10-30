// Sweeps and cards (v0.3): the Feed (cards grouped by sweep, newest first), card details with score traceability,
// sweep details with phases, counts and the cost split, and the cards-per-sweep setting.
import { isExploration } from "../plugins/rh.sweep/exploration.ts";
import { SettingsInvalid } from "./kernel/settings.ts";
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
  const paper = project.papers.store.get(paperId);
  if (!paper) return { id: paperId, title: "(removed)", authors: [] };
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    server: paper.server,
    link: paper.ids.doi ? `https://doi.org/${paper.ids.doi}` : (paper.url ?? paper.oaUrl),
    citations: paper.citedByCount,
    ...(withAbstract ? { abstract: paper.abstract } : {}),
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
    exploration: isExploration(project.db, card.sweepId, card.paperId),
    createdAt: card.createdAt,
    paper: paperMeta(project, card.paperId),
    judgment: judgmentView(project, card.id),
  };
}

function judgmentView(project: ProjectRuntime, cardId: number): JudgmentView | null {
  const j = project.feedback.get(cardId);
  return j
    ? {
        verdict: j.verdict,
        reason: j.reason,
        reasonKind: j.reasonKind,
        ruleStatus: j.ruleStatus,
        updatedAt: j.updatedAt,
      }
    : null;
}

function cardDetail(project: ProjectRuntime, card: Card): CardDetail {
  return {
    ...cardView(project, card),
    paper: paperMeta(project, card.paperId, true),
    details: card.details,
    weightEffects: project.feedback.effects(card.id),
  };
}

export function sweepSummary(project: ProjectRuntime, sweepRecord: SweepRecord): SweepSummary {
  const cards = Number(
    (project.db.prepare("SELECT COUNT(*) n FROM cards WHERE sweep_id = ?").get(sweepRecord.id) as { n: number }).n,
  );
  return {
    id: sweepRecord.id,
    trigger: sweepRecord.trigger,
    status: sweepRecord.status,
    phase: sweepRecord.phase,
    orientation: sweepRecord.orientation,
    counts: sweepRecord.counts,
    error: sweepRecord.error,
    nextRetryAt: sweepRecord.nextRetryAt,
    cost: sweepRecord.cost,
    cards,
    startedAt: sweepRecord.startedAt,
    endedAt: sweepRecord.endedAt,
  };
}

function findCard(project: ProjectRuntime, id: string) {
  const card = project.cards.get(int(id, "id"));
  if (!card) throw notFound(`No card ${id}`);
  return card;
}

/** The newest cards, grouped by the sweep that found them. */
function cardGroups(project: ProjectRuntime, limit: number): CardGroup[] {
  const groups: CardGroup[] = [];
  for (const card of project.cards.list(limit)) {
    let group = groups.at(-1);
    if (!group || group.sweep.id !== card.sweepId) {
      group = { sweep: sweepSummary(project, project.sweeps.get(card.sweepId)!), cards: [] };
      groups.push(group);
    }
    group.cards.push(cardView(project, card));
  }
  return groups;
}

/** A sweep with its queries, phases and every paper it looked at. */
function sweepDetail(
  project: ProjectRuntime,
  sweep: NonNullable<ReturnType<ProjectRuntime["sweeps"]["get"]>>,
): SweepDetail {
  return {
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
      exploration: isExploration(project.db, sweep.id, sp.paperId),
    })),
  };
}

export function sweepRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const currentProject = () => hub.project;

  router.get("/v1/cards", (request, response) => {
    const limit = Math.min(int(request.query.limit, "limit", 100), 500);
    response.json({ groups: cardGroups(currentProject(), limit) });
  });

  router.get("/v1/cards/:id", (request, response) => {
    const project = currentProject();
    const card = findCard(project, request.params.id);
    response.json(cardDetail(project, card));
  });

  router.put("/v1/cards/:id/judgment", (request, response) => {
    const project = currentProject();
    const card = findCard(project, request.params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      project.feedback.judge(card.id, body.verdict, body.reason);
    } catch (error) {
      if (error instanceof JudgmentInvalid) throw invalid(error.message);
      throw error;
    }
    response.json(cardDetail(project, card));
  });

  router.delete("/v1/cards/:id/judgment", (request, response) => {
    const project = currentProject();
    const card = findCard(project, request.params.id);
    project.feedback.clear(card.id);
    response.json(cardDetail(project, card));
  });

  router.get(
    "/v1/feedback/precision",
    (_request, response) => void response.json(currentProject().feedback.precision()),
  );
  router.get("/v1/weights", (_request, response) => void response.json(currentProject().feedback.weights()));

  router.get("/v1/sweeps", (request, response) => {
    const project = currentProject();
    response.json(
      project.sweeps.list(Math.min(int(request.query.limit, "limit", 50), 200)).map((s) => sweepSummary(project, s)),
    );
  });

  router.get("/v1/sweeps/:id", (request, response) => {
    const project = currentProject();
    const sweep = project.sweeps.get(int(request.params.id, "id"));
    if (!sweep) throw notFound(`No sweep ${request.params.id}`);
    response.json(sweepDetail(project, sweep));
  });

  router.get(
    "/v1/sweep-settings",
    (_request, response) => void response.json({ cardsPerSweep: currentProject().sweeps.cardsPerSweep() }),
  );

  router.put("/v1/sweep-settings", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.cardsPerSweep !== undefined) {
      // A plugin setting since v1-1: the change is recorded in the plugin history and can be undone.
      try {
        await currentProject().plugins.kernel.configure("rh.sweep", { cardsPerSweep: body.cardsPerSweep });
      } catch (error) {
        if (error instanceof SettingsInvalid) throw invalid(error.problems.join("; "));
        throw error;
      }
    }
    response.json({ cardsPerSweep: currentProject().sweeps.cardsPerSweep() });
  });

  return router;
}
