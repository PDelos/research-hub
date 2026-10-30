// Card scores (spec paper-cards; design D5): computed by code from recorded Jev decisions and metadata, never by the
// agent. Each score is 0–100 with a reason of at most 120 characters; `details` keeps every input for traceability.
import type { Charter } from "../charter.ts";
import type { Paper } from "../papers/store.ts";
import type { SweepPaper } from "./sweep.ts";

export interface CardScores {
  relevance: number;
  relevanceReason: string;
  trust: number;
  trustReason: string;
  value: number;
  valueReason: string;
  level: string;
  matchedQuestion?: string;
  borderline: boolean;
  details: ScoreDetails;
}

export interface ScoreDetails {
  decisions: Record<string, { version: number; answers: unknown }>;
  inputs: Record<string, unknown>;
  formulas: Record<string, string>;
}

/** arXiv fields where posting preprints is the norm, so a preprint says little about quality. */
export const PREPRINT_NORM = /^(cs|q-bio|stat\.ML)(\.|$)/;
const PREPRINT_SERVERS = new Set(["arXiv", "bioRxiv", "medRxiv", "ChemRxiv"]);

/** Join reason parts with " · " within 120 characters; a part that does not fit is cut with "…" when room allows. */
export const reason = (parts: string[]): string => {
  let out = "";
  for (const part of parts) {
    const next = out ? `${out} · ${part}` : part;
    if (next.length <= 120) {
      out = next;
      continue;
    }
    const room = 120 - (out ? out.length + 3 : 0) - 1;
    if (room >= 20) out = `${out ? `${out} · ` : ""}${part.slice(0, room).trimEnd()}…`;
    break;
  }
  return out;
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Relevance: Jev on-theme and the matched question's weight. */
function relevanceOf(sp: SweepPaper, charter: Charter) {
  const question = charter.questions.find((q) => q.id === sp.matchedQuestion);
  const weight = question?.weight ?? 0.5;
  const jev = sp.relevance ?? 0;
  return {
    weight,
    jev,
    score: clamp(100 * (0.75 * jev + 0.25 * Math.min(1, weight / 2))),
    reason: reason([
      `Jev relevance ${jev.toFixed(2)}`,
      question ? `${question.id} (weight ${question.weight}): ${question.text}` : "no research question matched",
    ]),
  };
}

/** Peer review counts for trust; a preprint loses less in fields where preprints are the norm. */
function reviewTrust(paper: Paper, isPreprint: boolean, preprintNorm: boolean): { points: number; note: string } {
  if (paper.venue) return { points: 20, note: `peer-reviewed: ${paper.venue}` };
  if (!isPreprint) return { points: 0, note: "venue unknown" };
  if (preprintNorm)
    return { points: -5, note: `${paper.server} preprint (${paper.categories[0]}: preprints are the norm, −5)` };
  return { points: -15, note: `${paper.server} preprint, not peer-reviewed (−15)` };
}

/** Trust: peer review (field-aware for preprints), citation velocity, open access, a described method. */
function trustOf(paper: Paper, now: number, hasMethodFacet: boolean) {
  const isPreprint = !paper.venue && !!paper.server && PREPRINT_SERVERS.has(paper.server);
  const preprintNorm = paper.categories.some((c) => PREPRINT_NORM.test(c));
  const published = Date.parse(paper.publishedAt ?? `${paper.year ?? 2000}-07-01`);
  const years = Math.max(1, (now - published) / (365.25 * 86_400_000));
  const citations = paper.citedByCount ?? 0;
  const velocity = citations / years;
  const review = reviewTrust(paper, isPreprint, preprintNorm);
  const parts = [
    review.note,
    paper.citedByCount === undefined ? "citations unknown" : `${citations} citations (${velocity.toFixed(1)}/year)`,
    ...(paper.oaUrl ? ["open access"] : []),
    ...(hasMethodFacet ? ["method described"] : []),
  ];
  const trust =
    50 + review.points + Math.min(20, 6 * Math.log2(1 + velocity)) + (paper.oaUrl ? 5 : 0) + (hasMethodFacet ? 5 : 0);
  return { score: clamp(trust), reason: reason(parts), isPreprint, preprintNorm, velocity };
}

/** Value: novelty, worth reading, and how actionable the kind of paper is. */
function valueOf(sp: SweepPaper, orientation: boolean) {
  const novelty = sp.novelty ?? 0;
  const worth = sp.worth ?? 0;
  const kind = sp.kind ?? "other";
  const kindFactor = kindValue(kind, orientation);
  return {
    novelty,
    worth,
    kind,
    score: clamp(100 * (0.55 * novelty + 0.3 * worth + 0.15 * kindFactor)),
    reason: reason([
      `novelty ${novelty.toFixed(2)}`,
      `worth reading ${worth.toFixed(2)}`,
      `${kind}${orientation && kindFactor === 0.9 ? " (good start for a newcomer)" : ""}`,
    ]),
  };
}

export function computeScores(
  paper: Paper,
  sp: SweepPaper,
  charter: Charter,
  options: { orientation: boolean; now: number; decisions: ScoreDetails["decisions"]; hasMethodFacet: boolean },
): CardScores {
  const relevance = relevanceOf(sp, charter);
  const trust = trustOf(paper, options.now, options.hasMethodFacet);
  const value = valueOf(sp, options.orientation);
  return {
    relevance: relevance.score,
    relevanceReason: relevance.reason,
    trust: trust.score,
    trustReason: trust.reason,
    value: value.score,
    valueReason: value.reason,
    level: sp.level ?? "core",
    matchedQuestion: sp.matchedQuestion,
    borderline: sp.borderline,
    details: {
      decisions: options.decisions,
      inputs: {
        relevance: relevance.jev,
        matchedQuestion: sp.matchedQuestion,
        questionWeight: relevance.weight,
        venue: paper.venue,
        server: paper.server,
        categories: paper.categories,
        preprint: trust.isPreprint,
        preprintNorm: trust.preprintNorm,
        citations: paper.citedByCount,
        citationsPerYear: Number(trust.velocity.toFixed(2)),
        openAccess: !!paper.oaUrl,
        methodDescribed: options.hasMethodFacet,
        novelty: value.novelty,
        worth: value.worth,
        kind: value.kind,
        level: sp.level,
        importance: sp.importance,
        rankScore: sp.rankScore,
        orientation: options.orientation,
      },
      formulas: {
        relevance: "100 × (0.75 × Jev relevance + 0.25 × min(1, question weight / 2))",
        trust:
          "50 + peer-reviewed 20 | preprint −5 (cs.*, q-bio.*) or −15 + min(20, 6 × log2(1 + citations/year)) + open access 5 + method described 5",
        value: "100 × (0.55 × novelty + 0.30 × worth + 0.15 × kind factor)",
      },
    },
  };
}

/** How actionable a kind of paper is: methods and tools most; surveys count more while the user is orienting. */
function kindValue(kind: string, orientation: boolean): number {
  if (["method", "tool", "dataset", "benchmark"].includes(kind)) return 1;
  if (["survey", "review", "tutorial"].includes(kind)) return orientation ? 0.9 : 0.6;
  return 0.5;
}
