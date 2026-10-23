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

export const reason = (parts: string[]): string => {
  let out = "";
  for (const part of parts) {
    const next = out ? `${out} · ${part}` : part;
    if (next.length > 120) break;
    out = next;
  }
  return out.slice(0, 120);
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function computeScores(
  paper: Paper,
  sp: SweepPaper,
  charter: Charter,
  options: { orientation: boolean; now: number; decisions: ScoreDetails["decisions"]; hasMethodFacet: boolean },
): CardScores {
  // Relevance: Jev on-theme and the matched question's weight.
  const question = charter.questions.find((q) => q.id === sp.matchedQuestion);
  const weight = question?.weight ?? 0.5;
  const relevanceJev = sp.relevance ?? 0;
  const relevance = clamp(100 * (0.75 * relevanceJev + 0.25 * Math.min(1, weight / 2)));
  const relevanceReason = reason([
    `Jev relevance ${relevanceJev.toFixed(2)}`,
    question ? `${question.id} (weight ${question.weight}): ${question.text}` : "no research question matched",
  ]);

  // Trust: peer review (field-aware for preprints), citation velocity, open access, a described method.
  const isPreprint = !paper.venue && (!!paper.server && PREPRINT_SERVERS.has(paper.server));
  const preprintNorm = paper.categories.some((c) => PREPRINT_NORM.test(c));
  const years = Math.max(1, (options.now - Date.parse(paper.publishedAt ?? `${paper.year ?? 2000}-07-01`)) / (365.25 * 86_400_000));
  const citations = paper.citedByCount ?? 0;
  const velocity = citations / years;
  const parts: string[] = [];
  let trust = 50;
  if (paper.venue) {
    trust += 20;
    parts.push(`peer-reviewed: ${paper.venue}`);
  } else if (isPreprint) {
    const penalty = preprintNorm ? 5 : 15;
    trust -= penalty;
    parts.push(
      preprintNorm
        ? `${paper.server} preprint (${paper.categories[0]}: preprints are the norm, −${penalty})`
        : `${paper.server} preprint, not peer-reviewed (−${penalty})`,
    );
  } else parts.push("venue unknown");
  const citationPoints = Math.min(20, 6 * Math.log2(1 + velocity));
  trust += citationPoints;
  parts.push(paper.citedByCount === undefined ? "citations unknown" : `${citations} citations (${velocity.toFixed(1)}/year)`);
  if (paper.oaUrl) {
    trust += 5;
    parts.push("open access");
  }
  if (options.hasMethodFacet) {
    trust += 5;
    parts.push("method described");
  }
  const trustScore = clamp(trust);

  // Value: novelty, worth reading, and how actionable the kind of paper is.
  const novelty = sp.novelty ?? 0;
  const worth = sp.worth ?? 0;
  const kind = sp.kind ?? "other";
  const kindFactor = ["method", "tool", "dataset", "benchmark"].includes(kind)
    ? 1
    : ["survey", "review", "tutorial"].includes(kind)
      ? options.orientation
        ? 0.9
        : 0.6
      : 0.5;
  const value = clamp(100 * (0.55 * novelty + 0.3 * worth + 0.15 * kindFactor));
  const valueReason = reason([`novelty ${novelty.toFixed(2)}`, `worth reading ${worth.toFixed(2)}`, `${kind}${options.orientation && kindFactor === 0.9 ? " (good start for a newcomer)" : ""}`]);

  return {
    relevance,
    relevanceReason,
    trust: trustScore,
    trustReason: reason(parts),
    value,
    valueReason,
    level: sp.level ?? "core",
    matchedQuestion: sp.matchedQuestion,
    borderline: sp.borderline,
    details: {
      decisions: options.decisions,
      inputs: {
        relevance: relevanceJev,
        matchedQuestion: sp.matchedQuestion,
        questionWeight: weight,
        venue: paper.venue,
        server: paper.server,
        categories: paper.categories,
        preprint: isPreprint,
        preprintNorm,
        citations: paper.citedByCount,
        citationsPerYear: Number(velocity.toFixed(2)),
        openAccess: !!paper.oaUrl,
        methodDescribed: options.hasMethodFacet,
        novelty,
        worth,
        kind,
        level: sp.level,
        importance: sp.importance,
        rankScore: sp.rankScore,
        orientation: options.orientation,
      },
      formulas: {
        relevance: "100 × (0.75 × Jev relevance + 0.25 × min(1, question weight / 2))",
        trust: "50 + peer-reviewed 20 | preprint −5 (cs.*, q-bio.*) or −15 + min(20, 6 × log2(1 + citations/year)) + open access 5 + method described 5",
        value: "100 × (0.55 × novelty + 0.30 × worth + 0.15 × kind factor)",
      },
    },
  };
}
