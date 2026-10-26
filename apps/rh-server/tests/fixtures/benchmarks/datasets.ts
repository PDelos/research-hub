// Tiny stand-ins for the public benchmark files (same formats: Parquet, TSV, JSONL), served by a fake fetch.
import { parquetWriteBuffer } from "hyparquet-writer";

const bytes = (ab: ArrayBuffer) => new Uint8Array(ab);
const pq = (columns: Record<string, (string | number)[]>) =>
  bytes(
    parquetWriteBuffer({
      columnData: Object.entries(columns).map(([name, data]) => ({
        name,
        data,
        type: typeof data[0] === "number" ? "INT32" : "STRING",
      })) as never,
    }),
  );

/** A corpus where query qN is about topic N and its relevant document says the same words. */
export function benchmarkFiles(): Map<string, Uint8Array> {
  const topics = Array.from({ length: 12 }, (_, i) => `topic${i} protein folding variant ${i}`);
  const docs = [
    ...topics.map((t, i) => ({ id: `d${i}`, title: t, text: `About ${t}.` })),
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `x${i}`,
      title: `unrelated ${i} gardening`,
      text: `Plants number ${i}.`,
    })),
  ];
  const queries = topics.map((t, i) => ({ id: `q${i}`, text: `Papers on ${t}` }));
  const qrels = topics.map((_, i) => ({ q: `q${i}`, d: `d${i}`, s: 1 }));
  const files = new Map<string, Uint8Array>();
  const HF = "https://huggingface.co/datasets";
  const corpus = pq({ _id: docs.map((d) => d.id), title: docs.map((d) => d.title), text: docs.map((d) => d.text) });
  files.set(`${HF}/BeIR/scidocs/resolve/main/corpus/corpus-00000-of-00001.parquet`, corpus);
  files.set(
    `${HF}/BeIR/scidocs/resolve/main/queries/queries-00000-of-00001.parquet`,
    pq({ _id: queries.map((q) => q.id), title: queries.map(() => ""), text: queries.map((q) => q.text) }),
  );
  files.set(
    `${HF}/BeIR/scidocs-qrels/resolve/main/test.tsv`,
    new TextEncoder().encode(
      ["query-id\tcorpus-id\tscore", ...qrels.map((r) => `${r.q}\t${r.d}\t${r.s}`), "q99\td1\t0"].join("\n"),
    ),
  );
  const LS = `${HF}/mteb/LitSearchRetrieval/resolve/main`;
  files.set(`${LS}/corpus/test-00000-of-00001.parquet`, corpus);
  files.set(
    `${LS}/queries/test-00000-of-00001.parquet`,
    pq({ _id: queries.map((q) => q.id), text: queries.map((q) => q.text) }),
  );
  files.set(
    `${LS}/qrels/test-00000-of-00001.parquet`,
    pq({ "query-id": qrels.map((r) => r.q), "corpus-id": qrels.map((r) => r.d), score: qrels.map((r) => r.s) }),
  );
  const labels = ["background", "objective", "methods", "results", "conclusions"];
  const lines = Array.from({ length: 5 }, (_, a) =>
    labels.map((label, i) =>
      JSON.stringify({
        abstract_id: `a${a}`,
        label,
        text: `Sentence ${i} of abstract ${a}, a ${label} sentence.`,
        sentence_id: i,
      }),
    ),
  ).flat();
  files.set(`${HF}/armanc/pubmed-rct20k/resolve/main/test.jsonl`, new TextEncoder().encode(lines.join("\n")));
  return files;
}

/** A fetch that answers the benchmark files and records each request. */
export function benchmarkFetch(files = benchmarkFiles()) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const body = files.get(url);
    return body ? new Response(body) : new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
