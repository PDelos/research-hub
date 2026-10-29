// The built-in question finders (spec knowledge-loop: Question finders; design v1-7 D2): leads for new research
// questions from the user's liked papers (their facet and whole vectors, citations) and from what the sweeps gather.
import type { Db } from "../db.ts";

export interface LikedPaper {
  id: number;
  title: string;
  abstract: string | null;
  question: string | null;
}

export interface Lead {
  summary: string;
  paperIds: number[];
}

type Vector = (paperId: number, kind: "whole" | "background" | "method") => Float32Array | undefined;

/** The papers the user liked (👍/⭐), newest first, at most `limit`. */
export function likedPapers(db: Db, limit = 60): LikedPaper[] {
  return (
    db
      .prepare(
        `SELECT p.id, p.title, p.abstract, c.matched_question question FROM judgments j JOIN papers p ON p.id = j.paper_id
           JOIN cards c ON c.id = j.card_id WHERE j.verdict IN ('up', 'star') ORDER BY j.updated_at DESC LIMIT ?`,
      )
      .all(limit) as { id: number; title: string; abstract: string | null; question: string | null }[]
  ).map((r) => ({ ...r, id: Number(r.id) }));
}

export function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    na += left[i] * left[i];
    nb += right[i] * right[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const quantile = (xs: number[], fraction: number) => {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : 0;
};
const short = (t: string) => (t.length > 70 ? `${t.slice(0, 67)}…` : t);

/** Same method, different problem: method vectors close (top 20 %), background vectors far (bottom 40 %). */
export function methodTransferLeads(liked: LikedPaper[], vector: Vector, limit = 3): Lead[] {
  const papers = liked
    .map((p) => ({ p, method: vector(p.id, "method"), background: vector(p.id, "background") }))
    .filter((x): x is typeof x & { method: Float32Array; background: Float32Array } => !!x.method && !!x.background);
  const pairs: { a: LikedPaper; b: LikedPaper; method: number; background: number }[] = [];
  for (let i = 0; i < papers.length; i++)
    for (let j = i + 1; j < papers.length; j++)
      pairs.push({
        a: papers[i].p,
        b: papers[j].p,
        method: cosine(papers[i].method, papers[j].method),
        background: cosine(papers[i].background, papers[j].background),
      });
  if (pairs.length < 3) return [];
  const methodMin = quantile(
    pairs.map((p) => p.method),
    0.8,
  );
  const backgroundMax = quantile(
    pairs.map((p) => p.background),
    0.4,
  );
  return pairs
    .filter((p) => p.method >= methodMin && p.background <= backgroundMax)
    .toSorted((x, y) => y.method - y.background - (x.method - x.background))
    .slice(0, limit)
    .map((p) => ({
      summary: `“${short(p.a.title)}” and “${short(p.b.title)}” use similar methods on different problems: has one's method been tried on the other's problem? (method similarity ${p.method.toFixed(2)}, background ${p.background.toFixed(2)})`,
      paperIds: [p.a.id, p.b.id],
    }));
}

/** Close papers (whole vectors, top 20 %) matched to different questions that never cite each other. */
export function unlinkedPairs(db: Db, liked: LikedPaper[], vector: Vector, limit = 5) {
  const papers = liked
    .map((p) => ({ p, whole: vector(p.id, "whole") }))
    .filter((x): x is typeof x & { whole: Float32Array } => !!x.whole && !!x.p.question);
  const pairs: { a: LikedPaper; b: LikedPaper; similarity: number }[] = [];
  for (let i = 0; i < papers.length; i++)
    for (let j = i + 1; j < papers.length; j++)
      if (papers[i].p.question !== papers[j].p.question)
        pairs.push({ a: papers[i].p, b: papers[j].p, similarity: cosine(papers[i].whole, papers[j].whole) });
  if (!pairs.length) return [];
  const min = quantile(
    pairs.map((p) => p.similarity),
    0.8,
  );
  const cites = db.prepare(
    "SELECT 1 FROM citation_links WHERE (citing_paper_id = ? AND cited_paper_id = ?) OR (citing_paper_id = ? AND cited_paper_id = ?)",
  );
  return pairs
    .filter((p) => p.similarity >= min && !cites.get(p.a.id, p.b.id, p.b.id, p.a.id))
    .toSorted((x, y) => y.similarity - x.similarity)
    .slice(0, limit);
}

const STOP = new Set(
  "about above after again against among based being below between could during every first further their there these those through under using where which while within without would towards toward large learning model models paper study approach method methods results based novel analysis framework improved efficient review reviews survey sequence sequences towards using perspectives progress challenges current future comprehensive".split(
    " ",
  ),
);
const terms = (title: string) => {
  const words = (title.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  const bigrams = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return new Set([...words, ...bigrams]);
};

/**
 * Words and word pairs rising in titles gathered in the last 14 days against the 60 days before (at least 20 papers),
 * not in the charter (a pair whose words both are counts as in it).
 */
export function risingTopicLeads(db: Db, charterText: string, now = Date.now(), limit = 3): Lead[] {
  const day = 86_400_000;
  const gathered = (from: number, to: number) =>
    db
      .prepare(
        `SELECT DISTINCT p.id, p.title FROM sweep_papers sp JOIN sweeps s ON s.id = sp.sweep_id JOIN papers p ON p.id = sp.paper_id
          WHERE s.started_at >= ? AND s.started_at < ?`,
      )
      .all(new Date(from).toISOString(), new Date(to).toISOString()) as { id: number; title: string }[];
  const recent = gathered(now - 14 * day, now + 1);
  const before = gathered(now - 74 * day, now - 14 * day);
  // Rising needs something to rise from: a new project has no "before".
  if (recent.length < 5 || before.length < 20) return [];
  const count = (rows: { title: string }[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of terms(r.title)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  };
  const recentCounts = count(recent);
  const beforeCounts = count(before);
  const charter = charterText.toLowerCase();
  return (
    [...recentCounts]
      .filter(([t, n]) => n >= 3 && !charter.includes(t) && !t.split(" ").every((w) => charter.includes(w)))
      // The earlier rate, at least one paper's share of everything seen (a new project has no "before").
      .map(([t, n]) => ({
        t,
        n,
        ratio:
          n /
          recent.length /
          Math.max((beforeCounts.get(t) ?? 0) / Math.max(1, before.length), 1 / (before.length + recent.length)),
      }))
      .filter((x) => x.ratio >= 3)
      .toSorted((x, y) => y.ratio - x.ratio || y.n - x.n)
      // A bigram and its words say the same thing: keep the first of overlapping terms.
      .filter((x, i, all) => !all.slice(0, i).some((y) => y.t.includes(x.t) || x.t.includes(y.t)))
      .slice(0, limit)
      .map((x) => ({
        summary: `“${x.t}” is rising: ${x.n} of ${recent.length} papers gathered in the last 14 days, ${beforeCounts.get(x.t) ?? 0} of ${before.length} in the 60 days before; the charter does not mention it`,
        paperIds: recent
          .filter((p) => terms(p.title).has(x.t))
          .slice(0, 4)
          .map((p) => Number(p.id)),
      }))
  );
}
