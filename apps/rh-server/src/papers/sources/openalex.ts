// OpenAlex: keyless search and the enrichment source (venue, citations, references, open access, retraction).
// Requests carry mailto=CONTACT_EMAIL for the polite pool.
import { cleanText, normalizeDate, normalizeIds, normalizeOpenAlexId } from "../normalize.ts";
import type { SourcePaper } from "../store.ts";
import { inWindow, queryTerms, type PaperSource, type SourceDeps, type SourceQuery } from "./types.ts";

export const OPENALEX_API = "https://api.openalex.org";
export const OPENALEX_SELECT =
  "id,doi,ids,display_name,publication_date,publication_year,authorships,primary_location,best_oa_location,cited_by_count,referenced_works,referenced_works_count,is_retracted,abstract_inverted_index,type";

export class OpenAlexSource implements PaperSource {
  readonly name = "openalex" as const;
  constructor(private readonly deps: SourceDeps) {}

  async search(sourceQuery: SourceQuery): Promise<SourcePaper[]> {
    const search = queryTerms(sourceQuery.query).join(" ");
    if (!search) return [];
    const filters: string[] = [];
    if (sourceQuery.since) filters.push(`from_publication_date:${sourceQuery.since}`);
    if (sourceQuery.until) filters.push(`to_publication_date:${sourceQuery.until}`);
    const body = await this.deps.http.json<{ results: any[] }>(
      this.url("/works", {
        search,
        ...(filters.length ? { filter: filters.join(",") } : {}),
        "per-page": String(Math.min(sourceQuery.limit, 100)),
      }),
      { source: this.name, budgetMs: sourceQuery.budgetMs },
    );
    return body.results
      .map(mapOpenAlexWork)
      .filter((p): p is SourcePaper => !!p && inWindow(p.publishedAt, sourceQuery.since, sourceQuery.until));
  }

  /** Works for up to 50 DOIs in one request; DOIs not in OpenAlex are absent from the map. */
  async byDois(dois: string[], budgetMs?: number): Promise<Map<string, SourcePaper>> {
    const found = new Map<string, SourcePaper>();
    for (let i = 0; i < dois.length; i += 50) {
      const chunk = dois.slice(i, i + 50);
      const body = await this.deps.http.json<{ results: any[] }>(
        this.url("/works", { filter: `doi:${chunk.join("|")}`, "per-page": "50" }),
        { source: this.name, budgetMs },
      );
      for (const work of body.results) {
        const paper = mapOpenAlexWork(work);
        if (paper?.ids.doi) found.set(paper.ids.doi, paper);
      }
    }
    return found;
  }

  /** One work by OpenAlex ID, PMID or PMCID; undefined when OpenAlex does not know it (404). */
  async lookup(
    kind: "openalex" | "pmid" | "pmcid",
    value: string,
    budgetMs?: number,
  ): Promise<SourcePaper | undefined> {
    const key = kind === "openalex" ? value : `${kind}:${value}`;
    const response = await this.deps.http.request(this.url(`/works/${encodeURIComponent(key)}`, {}), {
      source: this.name,
      budgetMs,
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return undefined;
    return mapOpenAlexWork(await response.json()) ?? undefined;
  }

  private url(path: string, params: Record<string, string>): string {
    const search = new URLSearchParams({ ...params, select: OPENALEX_SELECT });
    if (this.deps.http.contactEmail) search.set("mailto", this.deps.http.contactEmail);
    return `${OPENALEX_API}${path}?${search}`;
  }
}

const countOf = (value: unknown) => (typeof value === "number" ? value : undefined);

/** A repository (bioRxiv, arXiv) is the preprint server; any other host is the venue. */
function hostOf(work: any): { venue: string | undefined; server: string | undefined } {
  const host = work.primary_location?.source ?? {};
  if (host.type === "repository") return { venue: undefined, server: serverName(host.display_name) };
  return { venue: host.display_name ? cleanText(host.display_name) : undefined, server: undefined };
}

/** The open-access copy (PDF first) and the landing page, falling back to the DOI and then OpenAlex. */
function linksOf(work: any, ids: SourcePaper["ids"], openalex: string): { oaUrl?: string; url: string } {
  const open = work.best_oa_location;
  const fallback = ids.doi ? `https://doi.org/${ids.doi}` : `https://openalex.org/${openalex}`;
  return {
    oaUrl: open?.pdf_url ?? open?.landing_page_url ?? undefined,
    url: work.primary_location?.landing_page_url ?? fallback,
  };
}

export function mapOpenAlexWork(work: any): SourcePaper | null {
  const openalex = normalizeOpenAlexId(work?.id);
  const title = cleanText(work?.display_name ?? work?.title);
  if (!openalex || !title) return null;
  const ids = normalizeIds({ openalex, doi: work.doi ?? work.ids?.doi, pmid: work.ids?.pmid, pmcid: work.ids?.pmcid });
  return {
    source: "openalex",
    externalId: openalex,
    ids,
    title,
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    authors: (work.authorships ?? [])
      .map((a: any) => cleanText(a?.author?.display_name ?? a?.raw_author_name))
      .filter(Boolean),
    year: work.publication_year ?? undefined,
    publishedAt: normalizeDate(work.publication_date),
    ...hostOf(work),
    ...linksOf(work, ids, openalex),
    citedByCount: countOf(work.cited_by_count),
    referencesCount: countOf(work.referenced_works_count),
    retracted: work.is_retracted === true,
    references: Array.isArray(work.referenced_works) ? work.referenced_works : undefined,
  };
}

/** "bioRxiv (Cold Spring Harbor Laboratory)" → "bioRxiv"; other repositories keep their name. */
export function serverName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (lower.includes("biorxiv")) return "bioRxiv";
  if (lower.includes("medrxiv")) return "medRxiv";
  if (lower.includes("arxiv")) return "arXiv";
  if (lower.includes("chemrxiv")) return "ChemRxiv";
  return cleanText(name);
}

/** Rebuild an abstract from OpenAlex's {word: [positions]} index, dropping a leading "Abstract" label. */
export function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  const text = cleanText(words.filter((w) => w !== undefined).join(" ")).replace(/^abstract[:.]?\s+/i, "");
  return text || undefined;
}
