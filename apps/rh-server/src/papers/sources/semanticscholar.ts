// Semantic Scholar: used only with S2_API_KEY (the keyless pool answers HTTP 429); the key goes in x-api-key.
import { cleanText, normalizeDate, normalizeIds } from "../normalize.ts";
import type { SourcePaper } from "../store.ts";
import { inWindow, queryTerms, type PaperSource, type SourceDeps, type SourceQuery } from "./types.ts";

export const S2_API = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = "title,abstract,authors,year,publicationDate,venue,externalIds,citationCount,openAccessPdf,url";

export class SemanticScholarSource implements PaperSource {
  readonly name = "semanticscholar" as const;
  constructor(
    private readonly deps: SourceDeps & { apiKey: string },
  ) {}

  async search(q: SourceQuery): Promise<SourcePaper[]> {
    const query = queryTerms(q.query).join(" ");
    if (!query) return [];
    const params = new URLSearchParams({ query, limit: String(Math.min(q.limit, 100)), fields: FIELDS });
    if (q.since || q.until) params.set("publicationDateOrYear", `${q.since ?? ""}:${q.until ?? ""}`);
    const body = await this.deps.http.json<{ data?: any[] }>(`${S2_API}?${params}`, {
      source: this.name,
      budgetMs: q.budgetMs,
      headers: { "x-api-key": this.deps.apiKey },
    });
    return (body.data ?? []).map(mapS2Paper).filter((p): p is SourcePaper => !!p && inWindow(p.publishedAt, q.since, q.until));
  }
}

export function mapS2Paper(p: any): SourcePaper | null {
  const title = cleanText(p?.title);
  if (!title || !p.paperId) return null;
  const x = p.externalIds ?? {};
  return {
    source: "semanticscholar",
    externalId: p.paperId,
    ids: normalizeIds({ s2: p.paperId, doi: x.DOI, arxiv: x.ArXiv, pmid: x.PubMed, pmcid: x.PubMedCentral }),
    title,
    abstract: cleanText(p.abstract) || undefined,
    authors: (p.authors ?? []).map((a: any) => cleanText(a.name)).filter(Boolean),
    year: p.year ?? undefined,
    publishedAt: normalizeDate(p.publicationDate) ?? (p.year ? `${p.year}-01-01` : undefined),
    venue: cleanText(p.venue) || undefined,
    oaUrl: p.openAccessPdf?.url ?? undefined,
    url: p.url,
    citedByCount: typeof p.citationCount === "number" ? p.citationCount : undefined,
  };
}
