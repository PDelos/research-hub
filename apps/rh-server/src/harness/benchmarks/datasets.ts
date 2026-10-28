// Public benchmark datasets and their fixed samples (spec slots: Datasets and fixed samples; design v1-3 D3):
// downloaded once per project from their source, sampled with a fixed seed, cached in the harness plugin's storage
// and reused by every later run, so results compare week to week. Licenses stay with the datasets (SCIDOCS:
// CC BY-SA 4.0, LitSearch: MIT, PubMed 20k RCT: its authors' terms); nothing is redistributed.
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { seeded } from "../replay.ts";

/** 2: documents without text are left out (an embeddings API refuses empty input). */
export const SAMPLE_VERSION = 2;
export const SAMPLE_SEED = 7;
const QUERIES = 100;
const DISTRACTORS = 1_900;
const HF = "https://huggingface.co/datasets";

export interface RetrievalSample {
  dataset: string;
  version: number;
  seed: number;
  queries: { id: string; text: string }[];
  docs: { id: string; text: string }[];
  /** query id → relevant doc ids */
  relevant: Record<string, string[]>;
}

export type FacetLabel = "background" | "method" | "result" | "other";
export interface FacetSample {
  dataset: string;
  version: number;
  seed: number;
  abstracts: { id: string; sentences: { text: string; label: FacetLabel }[] }[];
}

/** How a sample gets its bytes and where it is cached (the harness passes its rh API). */
export interface DatasetIo {
  offline: boolean;
  /** Download a file (through rh.http: declared hosts, paced, logged). */
  fetchBytes(url: string): Promise<Uint8Array>;
  readCache(name: string): string | undefined;
  writeCache(name: string, content: string): void;
}

export class SampleUnavailable extends Error {}

function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function parquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (await parquetReadObjects({ file, compressors })) as Record<string, unknown>[];
}

const docText = (r: Record<string, unknown>) =>
  [r.title, r.text]
    .filter((x) => typeof x === "string" && x.trim())
    .join(". ")
    .slice(0, 2_000);

/** Pick the sample: queries with a relevant document, their relevant documents, and seeded distractors. */
export function sampleRetrieval(
  dataset: string,
  queries: { id: string; text: string }[],
  corpus: { id: string; text: string }[],
  qrels: { query: string; doc: string; score: number }[],
): RetrievalSample {
  const random = seeded(SAMPLE_SEED);
  corpus = corpus.filter((d) => d.text.trim());
  const corpusIds = new Set(corpus.map((d) => d.id));
  const relevant: Record<string, string[]> = {};
  for (const q of qrels) if (q.score > 0 && corpusIds.has(q.doc)) (relevant[q.query] ??= []).push(q.doc);
  const chosen = shuffle(
    queries.filter((q) => relevant[q.id]?.length).toSorted((a, b) => a.id.localeCompare(b.id)),
    random,
  ).slice(0, QUERIES);
  const needed = new Set(chosen.flatMap((q) => relevant[q.id]));
  const distractors = shuffle(
    corpus.filter((d) => !needed.has(d.id)).toSorted((a, b) => a.id.localeCompare(b.id)),
    random,
  ).slice(0, DISTRACTORS);
  const byId = new Map(corpus.map((d) => [d.id, d]));
  return {
    dataset,
    version: SAMPLE_VERSION,
    seed: SAMPLE_SEED,
    queries: chosen,
    docs: [...[...needed].map((id) => byId.get(id)!), ...distractors],
    relevant: Object.fromEntries(chosen.map((q) => [q.id, relevant[q.id]])),
  };
}

const PUBMED_LABELS: Record<string, FacetLabel> = {
  background: "background",
  objective: "background",
  methods: "method",
  results: "result",
  conclusions: "result",
};

export function samplePubmed(lines: string[]): FacetSample {
  const abstracts = new Map<string, { i: number; text: string; label: FacetLabel }[]>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { abstract_id: string; label: string; text: string; sentence_id: number };
    (abstracts.get(r.abstract_id) ?? abstracts.set(r.abstract_id, []).get(r.abstract_id)!).push({
      i: r.sentence_id,
      text: r.text,
      label: PUBMED_LABELS[r.label.toLowerCase()] ?? "other",
    });
  }
  const ids = shuffle([...abstracts.keys()].toSorted(), seeded(SAMPLE_SEED)).slice(0, QUERIES);
  return {
    dataset: "pubmed-rct",
    version: SAMPLE_VERSION,
    seed: SAMPLE_SEED,
    abstracts: ids.map((id) => ({
      id,
      sentences: abstracts
        .get(id)!
        .toSorted((a, b) => a.i - b.i)
        .map(({ text, label }) => ({ text, label })),
    })),
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const BUILDERS = {
  async scidocs(io: DatasetIo): Promise<RetrievalSample> {
    const corpus = (
      await parquet(await io.fetchBytes(`${HF}/BeIR/scidocs/resolve/main/corpus/corpus-00000-of-00001.parquet`))
    ).map((r) => ({
      id: String(r._id),
      text: docText(r),
    }));
    const queries = (
      await parquet(await io.fetchBytes(`${HF}/BeIR/scidocs/resolve/main/queries/queries-00000-of-00001.parquet`))
    ).map((r) => ({
      id: String(r._id),
      text: String(r.text),
    }));
    const qrels = text(await io.fetchBytes(`${HF}/BeIR/scidocs-qrels/resolve/main/test.tsv`))
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .map(([query, doc, score]) => ({ query, doc, score: Number(score) }));
    return sampleRetrieval("scidocs", queries, corpus, qrels);
  },
  async litsearch(io: DatasetIo): Promise<RetrievalSample> {
    const base = `${HF}/mteb/LitSearchRetrieval/resolve/main`;
    const corpus = (await parquet(await io.fetchBytes(`${base}/corpus/test-00000-of-00001.parquet`))).map((r) => ({
      id: String(r._id),
      text: docText(r),
    }));
    const queries = (await parquet(await io.fetchBytes(`${base}/queries/test-00000-of-00001.parquet`))).map((r) => ({
      id: String(r._id),
      text: String(r.text),
    }));
    const qrels = (await parquet(await io.fetchBytes(`${base}/qrels/test-00000-of-00001.parquet`))).map((r) => ({
      query: String(r["query-id"]),
      doc: String(r["corpus-id"]),
      score: Number(r.score),
    }));
    return sampleRetrieval("litsearch", queries, corpus, qrels);
  },
  async "pubmed-rct"(io: DatasetIo): Promise<FacetSample> {
    return samplePubmed(text(await io.fetchBytes(`${HF}/armanc/pubmed-rct20k/resolve/main/test.jsonl`)).split("\n"));
  },
} as const;

export type DatasetName = keyof typeof BUILDERS;
export const DATASETS = Object.keys(BUILDERS) as DatasetName[];

/** The cached sample, built (and downloaded) the first time; offline, only a cached sample is available. */
export async function loadSample<N extends DatasetName>(
  name: N,
  io: DatasetIo,
): Promise<{ sample: N extends "pubmed-rct" ? FacetSample : RetrievalSample; downloaded: boolean }> {
  const file = `benchmarks/${name}-v${SAMPLE_VERSION}.json`;
  const cached = io.readCache(file);
  type S = N extends "pubmed-rct" ? FacetSample : RetrievalSample;
  if (cached) return { sample: JSON.parse(cached) as S, downloaded: false };
  if (io.offline)
    throw new SampleUnavailable(`the ${name} sample is not downloaded yet, and offline mode makes no downloads`);
  const sample = (await BUILDERS[name](io)) as S;
  io.writeCache(file, JSON.stringify(sample));
  return { sample, downloaded: true };
}
