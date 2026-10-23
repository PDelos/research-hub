// Search fan-out: every enabled source in parallel, failures isolated and reported, results merged into one record
// per work, then enriched from OpenAlex (cached 7 days; works not yet in OpenAlex stay pending and are retried on a
// later search). Spec paper-sources.
import type { Logger } from "../logger.ts";
import { PoliteHttp, SourceError } from "./http.ts";
import { ArxivSource } from "./sources/arxiv.ts";
import { EuropePmcSource } from "./sources/europepmc.ts";
import { OpenAlexSource } from "./sources/openalex.ts";
import { SemanticScholarSource } from "./sources/semanticscholar.ts";
import { inWindow, type PaperSource } from "./sources/types.ts";
import { CACHE_TTL_MS, MetadataCache, MISS_TTL_MS, PaperStore, type Paper, type SourceName, type SourcePaper } from "./store.ts";

export const SEARCH_LIMIT_DEFAULT = 25;
export const SEARCH_LIMIT_MAX = 100;
/** Older pending records retried per search. */
const ENRICH_RETRY_BATCH = 10;

export interface SearchRequest {
  query: string;
  since?: string;
  until?: string;
  limit?: number;
  /** Per-source time budget (interactive default 60 s). */
  budgetMs?: number;
}

export interface SourceReport {
  source: SourceName;
  status: "ok" | "failed" | "skipped";
  count: number;
  error?: string;
}

export interface SearchResult {
  papers: Paper[];
  sources: SourceReport[];
  created: number;
  merged: number;
  enrichment: { done: number; pending: number; error?: string };
}

export interface PaperSearchOptions {
  store: PaperStore;
  cache: MetadataCache;
  http: PoliteHttp;
  s2ApiKey?: string;
  log?: Logger;
  /** Replace the source clients (tests). */
  sources?: PaperSource[];
}

export class PaperSearch {
  readonly sources: PaperSource[];
  private readonly openalex: OpenAlexSource;

  constructor(private readonly options: PaperSearchOptions) {
    const deps = { http: options.http };
    this.openalex = new OpenAlexSource(deps);
    this.sources = options.sources ?? [
      new ArxivSource(deps),
      this.openalex,
      new EuropePmcSource(deps),
      ...(options.s2ApiKey ? [new SemanticScholarSource({ ...deps, apiKey: options.s2ApiKey })] : []),
    ];
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const limit = request.limit ?? SEARCH_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX)
      throw new RangeError(`limit must be 1 to ${SEARCH_LIMIT_MAX}, got ${request.limit}`);
    const query = request.query.trim();
    if (!query) throw new RangeError("query must not be empty");
    const q = { query, since: request.since, until: request.until, limit, budgetMs: request.budgetMs ?? 60_000 };

    const settled = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return { source: source.name, results: await source.search(q) };
        } catch (error) {
          const reason = error instanceof SourceError ? error.message : error instanceof Error ? error.message : String(error);
          this.options.log?.warn("papers.source_failed", { source: source.name, error: reason });
          return { source: source.name, results: [] as SourcePaper[], error: reason };
        }
      }),
    );
    const reports: SourceReport[] = settled.map((s) => ({
      source: s.source,
      status: s.error ? "failed" : "ok",
      count: s.results.length,
      ...(s.error ? { error: s.error } : {}),
    }));
    if (!this.options.s2ApiKey && !this.options.sources)
      reports.push({ source: "semanticscholar", status: "skipped", count: 0, error: "no S2_API_KEY" });

    // Store in rank order across sources (1st of each, then 2nd of each, ...), so the best of every source leads.
    const rank = new Map<number, number>();
    let created = 0;
    let merged = 0;
    const longest = Math.max(0, ...settled.map((s) => s.results.length));
    for (let i = 0; i < longest; i++)
      for (const s of settled) {
        const result = s.results[i];
        if (!result) continue;
        const stored = this.options.store.upsert(result);
        if (stored.created) created++;
        else merged++;
        for (const gone of stored.merged) rank.delete(gone);
        if (!rank.has(stored.id)) rank.set(stored.id, rank.size);
        // An OpenAlex search result is already a full OpenAlex record.
        if (s.source === "openalex") this.options.store.setEnrichment(stored.id, "done");
      }

    const ids = [...rank.keys()];
    const enrichment = await this.enrich(ids, q.budgetMs);
    const papers = ids
      .map((id) => this.options.store.get(id))
      .filter((p): p is Paper => !!p && inWindow(p.publishedAt, request.since, request.until))
      .slice(0, limit);
    return { papers, sources: reports, created, merged, enrichment };
  }

  /** Enrich these records and up to 10 older pending ones from OpenAlex. */
  async enrich(ids: number[], budgetMs = 60_000): Promise<SearchResult["enrichment"]> {
    const { store, cache } = this.options;
    const targets = new Map<number, Paper>();
    for (const id of ids) {
      const p = store.get(id);
      if (p && p.enrichment === "pending") targets.set(id, p);
    }
    for (const p of store.pendingEnrichment(ENRICH_RETRY_BATCH)) targets.set(p.id, p);
    if (!targets.size) return { done: 0, pending: 0 };

    let error: string | undefined;
    // DOIs (an arXiv ID has the DOI 10.48550/arxiv.<id>) in batches; the cache answers repeats for 7 days.
    const doiOf = (p: Paper) => p.ids.doi ?? (p.ids.arxiv ? `10.48550/arxiv.${p.ids.arxiv}` : undefined);
    const found = new Map<number, SourcePaper | undefined>();
    const uncached: string[] = [];
    for (const p of targets.values()) {
      const doi = doiOf(p);
      if (!doi) continue;
      const key = `openalex:doi:${doi}`;
      const hit = cache.get<SourcePaper | null>(key);
      if (hit !== undefined) found.set(p.id, hit ?? undefined);
      else uncached.push(doi);
    }
    if (uncached.length) {
      try {
        const works = await this.openalex.byDois(uncached, budgetMs);
        for (const doi of uncached) {
          const work = works.get(doi);
          cache.set(`openalex:doi:${doi}`, work ?? null, work ? CACHE_TTL_MS : MISS_TTL_MS);
        }
        for (const p of targets.values()) {
          const doi = doiOf(p);
          if (doi && uncached.includes(doi)) found.set(p.id, works.get(doi));
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    // Without a DOI: PMID, PMCID or a known OpenAlex ID.
    for (const p of targets.values()) {
      if (doiOf(p) || error) continue;
      const kind = p.ids.openalex ? "openalex" : p.ids.pmid ? "pmid" : p.ids.pmcid ? "pmcid" : undefined;
      if (!kind) {
        store.setEnrichment(p.id, "missing"); // nothing OpenAlex can be asked about
        targets.delete(p.id);
        continue;
      }
      try {
        const value = p.ids[kind]!;
        found.set(p.id, await cache.through(`openalex:${kind}:${value}`, () => this.openalex.lookup(kind, value, budgetMs)));
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    let done = 0;
    let pending = 0;
    for (const p of targets.values()) {
      const work = found.get(p.id);
      if (work) {
        store.upsert(work);
        store.setEnrichment(store.find(work.ids)?.id ?? p.id, "done");
        done++;
      } else {
        store.setEnrichment(p.id, "pending");
        pending++;
      }
    }
    if (error) this.options.log?.warn("papers.enrichment_failed", { error, pending });
    return { done, pending, ...(error ? { error } : {}) };
  }
}
