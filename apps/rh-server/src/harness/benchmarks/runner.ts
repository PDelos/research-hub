// Benchmark presets (spec slots: Benchmark runs; design v1-3 D4): what a slot's implementation (or a candidate) scores
// on its fixed samples. Retrieval: rank documents by cosine to each query, nDCG@10 with binary relevance.
// Facets: macro-F1 over background, method and result.
import type { FacetLabel, FacetSample, RetrievalSample } from "./datasets.ts";

export interface TaskResult {
  task: string;
  metric: string;
  value: number | null;
  items: number;
  note?: string;
}

const BATCH = 64;

export async function embedAll(
  texts: string[],
  embed: (texts: string[]) => Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) out.push(...(await embed(texts.slice(i, i + BATCH))));
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** nDCG@k of a ranking against a set of relevant ids (binary gains). */
export function ndcgAt(ranked: string[], relevant: Set<string>, k = 10): number {
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (a, b) => a + b,
    0,
  );
  return ideal ? dcg / ideal : 0;
}

/** Retrieval over a sample: mean nDCG@10 over its queries (vectors are L2-normalized, so dot = cosine). */
export async function retrievalTask(
  task: string,
  sample: Pick<RetrievalSample, "queries" | "docs" | "relevant">,
  embed: (texts: string[]) => Promise<Float32Array[]>,
): Promise<TaskResult> {
  if (!sample.queries.length) return { task, metric: "nDCG@10", value: null, items: 0, note: "no queries" };
  const docVectors = await embedAll(
    sample.docs.map((d) => d.text),
    embed,
  );
  const queryVectors = await embedAll(
    sample.queries.map((q) => q.text),
    embed,
  );
  const scores = sample.queries.map((q, qi) => {
    const ranked = sample.docs
      .map((d, di) => ({ id: d.id, s: dot(queryVectors[qi], docVectors[di]) }))
      .toSorted((a, b) => b.s - a.s)
      .map((x) => x.id);
    return ndcgAt(ranked, new Set(sample.relevant[q.id]));
  });
  return {
    task,
    metric: "nDCG@10",
    value: scores.reduce((a, b) => a + b, 0) / scores.length,
    items: sample.queries.length + sample.docs.length,
  };
}

/** Facet labelling over a sample: macro-F1 over background, method and result ("other" counts as a miss). */
export async function facetsTask(
  sample: FacetSample,
  label: (title: string, sentences: string[]) => Promise<FacetLabel[]>,
): Promise<TaskResult> {
  const classes: FacetLabel[] = ["background", "method", "result"];
  const tally = Object.fromEntries(classes.map((c) => [c, { tp: 0, fp: 0, fn: 0 }])) as Record<
    string,
    { tp: number; fp: number; fn: number }
  >;
  let sentences = 0;
  for (const a of sample.abstracts) {
    const predicted = await label(
      "(benchmark abstract)",
      a.sentences.map((s) => s.text),
    );
    a.sentences.forEach((s, i) => {
      sentences++;
      const p = predicted[i] ?? "other";
      for (const c of classes) {
        if (p === c && s.label === c) tally[c].tp++;
        else if (p === c) tally[c].fp++;
        else if (s.label === c) tally[c].fn++;
      }
    });
  }
  const f1 = classes.map((c) => {
    const { tp, fp, fn } = tally[c];
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  });
  return {
    task: "pubmed-rct",
    metric: "macro-F1",
    value: f1.reduce((a, b) => a + b, 0) / f1.length,
    items: sentences,
  };
}
