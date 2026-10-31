// The sweep's rules as pure functions: which queries run, how Jev's answers read, how well a paper's level fits, and
// the rank score (spec paper-sweep; design D3; v1-2, v1-7).
import { normalized, type Answer, type ChoiceAnswer, type ScoreAnswer } from "@rh/jev";
import type { Charter, CharterQuestion } from "../charter.ts";
import type { Paper } from "../papers/store.ts";
import { clip } from "./decisions.ts";

export const LEVELS = ["foundational", "core", "advanced", "frontier"] as const;
export type Level = (typeof LEVELS)[number];

export const MAX_QUERIES = 15;
export const ORIENTATION_VARIANTS = 5;

export interface PlannedQuery {
  text: string;
  weight: number;
  variant?: "review";
}

// ---------------------------------------------------------------- plan

/**
 * Weighted draw without replacement (Efraimidis–Spirakis): each query gets the key u^(1/w) and the `max` largest
 * keys win, so a higher weight is drawn more often and every query with a positive weight can be drawn.
 */
export function drawQueries(
  queries: { text: string; weight: number }[],
  max: number,
  random: () => number,
): PlannedQuery[] {
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
  const variants = drawn
    .slice(0, ORIENTATION_VARIANTS)
    .map((q) => ({ text: `${q.text} review`, weight: q.weight, variant: "review" as const }));
  return [...drawn, ...variants];
}

// ---------------------------------------------------------------- scoring helpers

export const scoreOf = (a: Answer | undefined): number => (a && a.type === "score" ? normalized(a as ScoreAnswer) : 0);
export const noulOf = (a: Answer | undefined): number => (a && a.type === "noul" ? a.noul : 0);
export const choiceOf = (a: Answer | undefined): string | undefined =>
  a && a.type === "choice" ? (a as ChoiceAnswer).choice : undefined;

export function levelFrom(answer: Answer | undefined): Level {
  return LEVELS[Math.min(3, Math.max(0, Math.round(scoreOf(answer) * 3)))];
}

export type TargetLevel = Level | "auto";
export const TARGET_LEVELS: readonly TargetLevel[] = ["auto", ...LEVELS];

/**
 * How well a paper's level fits (design D3; v1-7 D4): in orientation, foundational first; with a target level, 1 at
 * the target and less per step away; "auto" keeps the earlier table (core best, then advanced and frontier).
 */
export function levelFit(level: Level, orientation: boolean, target: TargetLevel = "auto"): number {
  if (!orientation && target !== "auto")
    return [1, 0.75, 0.5, 0.3][Math.abs(LEVELS.indexOf(level) - LEVELS.indexOf(target))];
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

export interface RankWeights {
  importance: number;
  relevance: number;
  question: number;
  level: number;
  freshness: number;
}
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  importance: 0.4,
  relevance: 0.2,
  question: 0.15,
  level: 0.15,
  freshness: 0.1,
};

/** Rank score (design D3): importance first, then relevance, question weight, level fit and freshness. */
export function rankScore(
  x: {
    importance: number;
    relevance: number;
    questionWeight: number;
    levelFit: number;
    freshness: number;
  },
  rankWeights: RankWeights = DEFAULT_RANK_WEIGHTS,
): number {
  return (
    rankWeights.importance * x.importance +
    rankWeights.relevance * x.relevance +
    rankWeights.question * Math.min(1, x.questionWeight / 2) +
    rankWeights.level * x.levelFit +
    rankWeights.freshness * x.freshness
  );
}

export function questionWeight(charter: Charter, matched: string | undefined): number {
  return charter.questions.find((q) => q.id === matched)?.weight ?? 0.5;
}

export function gateVars(paper: Paper, charter: Charter) {
  return {
    title: paper.title,
    abstract: clip(paper.abstract) || "(no abstract)",
    questions: charter.questions.map((q: CharterQuestion) => ({ id: q.id, text: q.text })),
    question_options: {
      ...Object.fromEntries(charter.questions.map((q) => [q.id, q.text])),
      none: "None of the research questions",
    },
    concepts: charter.concepts,
    out_of_scope: charter.outOfScope,
  };
}
