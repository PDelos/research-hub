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

  async search(sourceQuery: SourceQuery): Promise<SourcePaper[]> {
    const terms = queryTerms(sourceQuery.query).map((t) => `all:${t.includes(" ") ? t : t.replace(/"/g, "")}`);
    if (!terms.length) return [];
    let query = terms.join(" AND ");
    if (sourceQuery.since || sourceQuery.until) {
      const from = (sourceQuery.since ?? "1991-01-01").replace(/-/g, "") + "0000";
      const to = (sourceQuery.until ?? "2999-12-31").replace(/-/g, "") + "2359";
      query += ` AND submittedDate:[${from} TO ${to}]`;
    }
    const params = new URLSearchParams({
      search_query: query,
      start: "0",
      max_results: String(sourceQuery.limit),
      sortBy: sourceQuery.since ? "submittedDate" : "relevance",
      sortOrder: "descending",
    });
    const xml = await this.deps.http.text(`${ARXIV_API}?${params}`, {
      source: this.name,
      budgetMs: sourceQuery.budgetMs,
    });
    return parseArxivFeed(xml).filter((p) => inWindow(p.publishedAt, sourceQuery.since, sourceQuery.until));
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
    const primary = entry["arxiv:primary_category"]?.term as string | undefined;
    const categories = [primary, ...(entry.category ?? []).map((c: any) => c.term as string)].filter(
      (c, i, all): c is string => !!c && all.indexOf(c) === i,
    );
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
      categories,
    });
  }
  return out;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return String((value as Record<string, unknown>)["#text"] ?? "");
  return String(value);
}
