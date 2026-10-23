// arXiv: the Atom API (export.arxiv.org), keyless; paced at 1 request per 3 s by PoliteHttp.
import { XMLParser } from "fast-xml-parser";
import { cleanText, normalizeArxivId, normalizeDate, normalizeDoi } from "../normalize.ts";
import type { SourcePaper } from "../store.ts";
import { inWindow, queryTerms, type PaperSource, type SourceDeps, type SourceQuery } from "./types.ts";

export const ARXIV_API = "https://export.arxiv.org/api/query";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "entry" || name === "author" || name === "link" || name === "category",
  processEntities: true,
});

export class ArxivSource implements PaperSource {
  readonly name = "arxiv" as const;
  constructor(private readonly deps: SourceDeps) {}

  async search(q: SourceQuery): Promise<SourcePaper[]> {
    const terms = queryTerms(q.query).map((t) => `all:${t.includes(" ") ? t : t.replace(/"/g, "")}`);
    if (!terms.length) return [];
    let query = terms.join(" AND ");
    if (q.since || q.until) {
      const from = (q.since ?? "1991-01-01").replace(/-/g, "") + "0000";
      const to = (q.until ?? "2999-12-31").replace(/-/g, "") + "2359";
      query += ` AND submittedDate:[${from} TO ${to}]`;
    }
    const params = new URLSearchParams({
      search_query: query,
      start: "0",
      max_results: String(q.limit),
      sortBy: q.since ? "submittedDate" : "relevance",
      sortOrder: "descending",
    });
    const xml = await this.deps.http.text(`${ARXIV_API}?${params}`, { source: this.name, budgetMs: q.budgetMs });
    return parseArxivFeed(xml).filter((p) => inWindow(p.publishedAt, q.since, q.until));
  }
}

export function parseArxivFeed(xml: string): SourcePaper[] {
  const feed = parser.parse(xml)?.feed;
  if (!feed) throw new Error("not an Atom feed");
  const out: SourcePaper[] = [];
  for (const entry of (feed.entry ?? []) as any[]) {
    const id = normalizeArxivId(text(entry.id));
    if (!id) continue; // arXiv answers errors as a single entry without an abs URL
    const title = cleanText(text(entry.title));
    if (!title) continue;
    const pdf = (entry.link ?? []).find((l: any) => l.title === "pdf")?.href;
    out.push({
      source: "arxiv",
      externalId: id,
      ids: { arxiv: id, doi: normalizeDoi(text(entry["arxiv:doi"])) },
      title,
      abstract: cleanText(text(entry.summary)) || undefined,
      authors: (entry.author ?? []).map((a: any) => cleanText(text(a.name))).filter(Boolean),
      publishedAt: normalizeDate(text(entry.published)),
      server: "arXiv",
      oaUrl: pdf,
      url: `https://arxiv.org/abs/${id}`,
    });
  }
  return out;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return String((value as Record<string, unknown>)["#text"] ?? "");
  return String(value);
}
