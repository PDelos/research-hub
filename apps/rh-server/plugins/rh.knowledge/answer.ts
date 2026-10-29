// The knowledge review's reading of the review model's answer (spec knowledge-loop: New research questions, Taste-rule
// proposals): its directions, out-of-scope topics and taste rules become proposals with evidence; anything incomplete
// is reported, not proposed. Plain functions over the answer and the evidence the model saw.
import type { Proposed } from "./evidence.ts";

/** A judged paper the model saw in the evidence (or one a finder's lead named). */
export interface EvidencePaper {
  id: number;
  title: string;
  verdict: string | null;
  reason: string | null;
  reason_kind: string | null;
}

export interface RuleCandidate {
  cardId: number;
  reason: string;
  kind: string | null;
}

export type Fields = Record<string, unknown>;

/** Text from the answer: trimmed, one line, at most `max` characters ("" when it is not text). */
export const textOf = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";

/** An answer field that should be a list (anything else is an empty list), at most `max` items. */
export const listOf = (value: unknown, max: number): Fields[] => (Array.isArray(value) ? value : []).slice(0, max);

export class AnswerReader {
  private readonly papers: Map<number, EvidencePaper>;

  constructor(evidence: EvidencePaper[]) {
    this.papers = new Map(evidence.map((paper) => [Number(paper.id), paper]));
  }

  /** The papers of the evidence the answer names (unknown ids dropped), at most 6. */
  paperList(ids: unknown) {
    return (Array.isArray(ids) ? ids : [])
      .map(Number)
      .filter((id) => this.papers.has(id))
      .slice(0, 6)
      .map((id) => {
        const paper = this.papers.get(id)!;
        return { id, title: paper.title, verdict: paper.verdict, reason: paper.reason };
      });
  }

  /** A reason the user reads: paper ids become short titles. */
  why(value: unknown): string {
    return textOf(value, 600)
      .replace(/(?:[Pp]apers? )?#(\d+)/g, (mention, id) => {
        const title = this.papers.get(Number(id))?.title;
        if (!title) return mention;
        return `“${title.length > 60 ? `${title.slice(0, 57)}…` : title}”`;
      })
      .slice(0, 500);
  }

  isOffTopic(paperId: number): boolean {
    const paper = this.papers.get(paperId);
    return paper?.verdict === "down" && paper.reason_kind === "off-topic";
  }
}

export interface Direction {
  question: string;
  queries: string[];
  papers: ReturnType<AnswerReader["paperList"]>;
  why: string;
  finder: string;
}

/** A direction with everything a proposal needs, or the reason it is incomplete. */
export function readDirection(
  fields: Fields,
  reader: AnswerReader,
  finders: Set<string>,
): Direction | { question: string; incomplete: string } {
  const question = textOf(fields.question, 300);
  const queries = listOf(fields.queries, 3)
    .map((query) => textOf(query, 120))
    .filter(Boolean);
  const papers = reader.paperList(fields.paperIds);
  if (!question || !queries.length || !papers.length)
    return { question: question || "(empty)", incomplete: "needs a question, queries and papers from the evidence" };
  const finder = typeof fields.finder === "string" && finders.has(fields.finder) ? fields.finder : "interests";
  return { question, queries, papers, why: reader.why(fields.why), finder };
}

/** An out-of-scope topic is proposed only when at least two of its papers were marked off topic. */
export function readOutOfScope(fields: Fields, reader: AnswerReader): { topic: string; proposal?: Proposed } {
  const topic = textOf(fields.topic, 120);
  const papers = reader.paperList(fields.paperIds).filter((paper) => reader.isOffTopic(paper.id));
  if (!topic || papers.length < 2) return { topic: topic || "(empty)" };
  return {
    topic,
    proposal: {
      change: { kind: "add-out-of-scope", topic },
      evidence: { summary: reader.why(fields.why) || "You marked these papers off topic.", papers },
    },
  };
}

/** Taste rules that generalize open rule candidates (rules naming no known candidate are dropped). */
export function readTasteRules(rules: unknown, candidates: RuleCandidate[]): Proposed[] {
  const known = new Set(candidates.map((candidate) => candidate.cardId));
  return listOf(rules, 2).flatMap((fields): Proposed[] => {
    const rule = textOf(fields.rule, 160);
    const ids = (Array.isArray(fields.candidateIds) ? fields.candidateIds : [])
      .map(Number)
      .filter((id) => known.has(id));
    if (rule.length < 3 || !ids.length) return [];
    const reasons = candidates
      .filter((candidate) => ids.includes(candidate.cardId))
      .map((candidate) => `“${candidate.reason.slice(0, 120)}”`);
    return [
      {
        change: { kind: "taste-rule", rule, candidateIds: ids },
        evidence: { summary: `From your reasons: ${reasons.join("; ")}`, papers: [] },
      },
    ];
  });
}

/** The prompt's sections for the finders' leads and the rule candidates. */
export function leadsAndCandidates(
  leads: { finder: string; summary: string; paperIds: number[] }[],
  candidates: RuleCandidate[],
): string {
  const leadLines = leads.map(
    (lead) => `- [${lead.finder}] ${lead.summary} (${lead.paperIds.map((id) => `#${id}`).join(", ")})`,
  );
  const candidateLines = candidates.map(
    (candidate) =>
      `- candidate ${candidate.cardId}${candidate.kind ? ` (${candidate.kind})` : ""}: “${candidate.reason.slice(0, 200)}”`,
  );
  return `\n\n## Leads from the question finders\n${leadLines.join("\n") || "none"}\n\n## Rule candidates (reasons that may generalize)\n${candidateLines.join("\n") || "none"}`;
}
