// The Converter slot's preset (spec slots: Converter slot in the catalog; design v1-6 D4): 10 fixed arXiv q-bio.BM
// papers that have both a PDF and a LaTeXML HTML version. The HTML is the ground truth; a converter is scored on how
// much of its words it recovers (word F1) and how many of its section headings it finds (heading recall).
import { arxivHtmlToSections, type Section } from "../../fulltext/parse.ts";
import type { DatasetIo } from "./datasets.ts";
import type { TaskResult } from "./runner.ts";

export const CONVERTER_SAMPLE_VERSION = 1;
/** Pinned versions: the PDFs and HTML never change, so results compare week to week. */
export const CONVERTER_PAPERS = [
  "2606.11057v1",
  "2606.10955v1",
  "2606.06717v1",
  "2606.05541v1",
  "2606.05474v1",
  "2606.04566v1",
  "2606.05227v1",
  "2606.14737v2",
  "2606.02462v2",
  "2606.01816v1",
] as const;

const words = (text: string) => text.toLowerCase().match(/[a-z]{3,}/g) ?? [];

/** F1 of the two texts' word multisets (lowercased words of 3+ letters). */
export function wordF1(candidate: string, truth: string): number {
  const count = (ws: string[]) => {
    const counts = new Map<string, number>();
    for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
    return counts;
  };
  const candidateWords = count(words(candidate));
  const truthWords = count(words(truth));
  let overlap = 0;
  for (const [w, n] of candidateWords) overlap += Math.min(n, truthWords.get(w) ?? 0);
  const cn = [...candidateWords.values()].reduce((a, b) => a + b, 0);
  const tn = [...truthWords.values()].reduce((a, b) => a + b, 0);
  if (!cn || !tn || !overlap) return 0;
  const precision = overlap / cn;
  const recall = overlap / tn;
  return (2 * precision * recall) / (precision + recall);
}

const normHeading = (h: string) =>
  h
    .toLowerCase()
    .replace(/^[\divx]+(\.\d+)*\.?\s+/, "")
    .replace(/[^a-z ]/g, "")
    .trim();

/** Share of the truth's section titles (not the abstract) found among the candidate's headings. */
export function headingRecall(candidate: Section[], truth: Section[]): number {
  const want = truth.map((s) => normHeading(s.title)).filter((h) => h && h !== "abstract");
  if (!want.length) return 0;
  const have = candidate.map((s) => normHeading(s.title));
  return (
    want.filter((w) => have.some((h) => h === w || (h.length > 3 && (h.includes(w) || w.includes(h))))).length /
    want.length
  );
}

export interface ConverterPaper {
  id: string;
  truth: Section[];
  pdf: Uint8Array;
}

/** Load the sample (cached in the harness's storage); papers that cannot be loaded are left out with a note. */
export async function loadConverterSample(io: DatasetIo): Promise<{ papers: ConverterPaper[]; notes: string[] }> {
  const papers: ConverterPaper[] = [];
  const notes: string[] = [];
  for (const id of CONVERTER_PAPERS) {
    const file = `benchmarks/converter-v${CONVERTER_SAMPLE_VERSION}/${id}.json`;
    try {
      let cached = io.readCache(file);
      if (!cached) {
        if (io.offline) throw new Error("offline and not cached");
        const html = new TextDecoder().decode(await io.fetchBytes(`https://arxiv.org/html/${id}`));
        const pdf = await io.fetchBytes(`https://arxiv.org/pdf/${id}`);
        cached = JSON.stringify({ id, truth: arxivHtmlToSections(html), pdf: Buffer.from(pdf).toString("base64") });
        io.writeCache(file, cached);
      }
      const entry = JSON.parse(cached) as { id: string; truth: Section[]; pdf: string };
      papers.push({ id, truth: entry.truth, pdf: new Uint8Array(Buffer.from(entry.pdf, "base64")) });
    } catch (error) {
      notes.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { papers, notes };
}

/** Score one converter on the sample: per paper (word F1 + heading recall) / 2; the task value is their mean. */
export async function converterTask(
  sample: { papers: ConverterPaper[]; notes: string[] },
  convert: (pdf: Uint8Array) => Promise<Section[]>,
): Promise<TaskResult & { perPaper: { id: string; f1: number; headings: number }[] }> {
  const perPaper: { id: string; f1: number; headings: number }[] = [];
  const notes = [...sample.notes];
  for (const p of sample.papers) {
    try {
      const out = await convert(p.pdf);
      const text = (ss: Section[]) =>
        ss
          .filter((s) => !/^abstract$/i.test(s.title))
          .map((s) => s.text)
          .join("\n");
      perPaper.push({ id: p.id, f1: wordF1(text(out), text(p.truth)), headings: headingRecall(out, p.truth) });
    } catch (error) {
      // A failed conversion scores 0: every converter is judged on the same papers.
      perPaper.push({ id: p.id, f1: 0, headings: 0 });
      notes.push(`${p.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const value = perPaper.length ? perPaper.reduce((a, x) => a + (x.f1 + x.headings) / 2, 0) / perPaper.length : null;
  return {
    task: "converter-arxiv",
    metric: "(word F1 + heading recall) / 2 against arXiv HTML",
    value,
    items: perPaper.length,
    ...(notes.length ? { note: notes.slice(0, 5).join("; ") } : {}),
    perPaper,
  };
}
