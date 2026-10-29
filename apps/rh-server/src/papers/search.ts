// Search fan-out: every enabled source in parallel, failures isolated and reported, results merged into one record
// per work, then enriched from OpenAlex (cached 7 days; works not yet in OpenAlex stay pending and are retried on a
// later search). Spec paper-sources.
import type { Logger } from "../logger.ts";
import { PoliteHttp } from "./http.ts";
import { ArxivSource } from "./sources/arxiv.ts";
import { EuropePmcSource } from "./sources/europepmc.ts";
import { OpenAlexSource } from "./sources/openalex.ts";
import { SemanticScholarSource } from "./sources/semanticscholar.ts";
import { inWindow, type PaperSource } from "./sources/types.ts";
import {
  CACHE_TTL_MS,
  MetadataCache,
  MISS_TTL_MS,
  PaperStore,
  type Paper,
  type SourceName,
  type SourcePaper,
} from "./store.ts";

export const SEARCH_LIMIT_DEFAULT = 25;
export const SEARCH_LIMIT_MAX = 100;
/** Older pending records retried per search. */
const ENRICH_RETRY_BATCH = 10;

type Chosen = Awaited<ReturnType<NonNullable<PaperSearchOptions["selected"]>>>;
type SourceQuery = Parameters<PaperSource["search"]>[0];
interface Settled {
  source: string;
  results: SourcePaper[];
  error?: string;
}

/** The limit and the query every source gets; a limit out of range or an empty query is a RangeError. */
function checkedQuery(request: SearchRequest): { limit: number; sourceQuery: SourceQuery } {
  const limit = request.limit ?? SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX)
    throw new RangeError(`limit must be 1 to ${SEARCH_LIMIT_MAX}, got ${request.limit}`);
  const query = request.query.trim();
  if (!query) throw new RangeError("query must not be empty");
  return {
    limit,
    sourceQuery: {
      query,
      since: request.since,
      until: request.until,
      limit: Math.min(request.perSource ?? limit, SEARCH_LIMIT_MAX),
      budgetMs: request.budgetMs ?? 60_000,
    },
  };
}

/** A paper's DOI; an arXiv ID has the DOI 10.48550/arxiv.<id>. */
const doiOf = (p: Paper) => p.ids.doi ?? (p.ids.arxiv ? `10.48550/arxiv.${p.ids.arxiv}` : undefined);

export interface SearchRequest {
  query: string;
  since?: string;
  until?: string;
  limit?: number;
  /** Per-source time budget (interactive default 60 s). */
  budgetMs?: number;
  /** Enrich from OpenAlex before returning (default true); the sweep enriches only gate survivors. */
  enrich?: boolean;
  /** Results asked of each source (default: `limit`); the sweep asks 10 per source and keeps them all. */
  perSource?: number;
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
  /**
   * The sources taking part in a search (v1-0: the enabled papers.source contributions): built-in clients by name,
   * plus clients contributed by plugins. All built-ins when absent.
   */
  selected?: () => Promise<{ builtin: ReadonlySet<string>; extra: PaperSource[]; enrich: boolean }>;
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
    const { limit, sourceQuery } = checkedQuery(request);
    const chosen = this.options.selected ? await this.options.selected() : undefined;
    const active = chosen ? [...this.sources.filter((x) => chosen.builtin.has(x.name)), ...chosen.extra] : this.sources;
    const settled = await Promise.all(active.map((source) => this.querySource(source, sourceQuery)));
    const reports = this.sourceReports(settled, chosen);
    const { ids, created, merged } = this.storeInRankOrder(settled);
    // Enrichment uses OpenAlex; without an enabled enricher the records stay as the sources gave them.
    const enrichment =
      request.enrich === false || (chosen && !chosen.enrich)
        ? { done: 0, pending: 0 }
        : await this.enrich(ids, sourceQuery.budgetMs);
    const papers = ids
      .map((id) => this.options.store.get(id))
      .filter((p): p is Paper => !!p && inWindow(p.publishedAt, request.since, request.until))
      .slice(0, limit);
    return { papers, sources: reports, created, merged, enrichment };
  }

  /** One source's results; a failing source gives none and its reason. */
  private async querySource(source: PaperSource, sourceQuery: SourceQuery): Promise<Settled> {
    try {
      return { source: source.name, results: await source.search(sourceQuery) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.warn("papers.source_failed", { source: source.name, error: reason });
      return { source: source.name, results: [], error: reason };
    }
  }

  /** What each source did, including the ones skipped because their plugin is off or a key is missing. */
  private sourceReports(settled: Settled[], chosen: Chosen | undefined): SourceReport[] {
    const reports: SourceReport[] = settled.map((s) => ({
      source: s.source,
      status: s.error ? "failed" : "ok",
      count: s.results.length,
      ...(s.error ? { error: s.error } : {}),
    }));
    for (const source of this.sources)
      if (chosen && !chosen.builtin.has(source.name))
        reports.push({ source: source.name, status: "skipped", count: 0, error: "its plugin is disabled" });
    if (!this.options.s2ApiKey && !this.options.sources && (!chosen || chosen.builtin.has("semanticscholar")))
      reports.push({ source: "semanticscholar", status: "skipped", count: 0, error: "no S2_API_KEY" });
    return reports;
  }

  /** Store in rank order across sources (1st of each, then 2nd of each, ...), so the best of every source leads. */
  private storeInRankOrder(settled: Settled[]) {
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
    return { ids: [...rank.keys()], created, merged };
  }

  /** Enrich these records and up to 10 older pending ones from OpenAlex. */
  async enrich(ids: number[], budgetMs = 60_000): Promise<SearchResult["enrichment"]> {
    const targets = this.enrichmentTargets(ids);
    if (!targets.size) return { done: 0, pending: 0 };
    const found = new Map<number, SourcePaper | undefined>();
    const error =
      (await this.enrichByDoi(targets, found, budgetMs)) ?? (await this.enrichByOtherIds(targets, found, budgetMs));
    const { done, pending } = this.applyEnrichment(targets, found);
    if (error) this.options.log?.warn("papers.enrichment_failed", { error, pending });
    return { done, pending, ...(error ? { error } : {}) };
  }

  private enrichmentTargets(ids: number[]): Map<number, Paper> {
    const { store } = this.options;
    const targets = new Map<number, Paper>();
    for (const id of ids) {
      const paper = store.get(id);
      if (paper && paper.enrichment === "pending") targets.set(id, paper);
    }
    for (const p of store.pendingEnrichment(ENRICH_RETRY_BATCH)) targets.set(p.id, p);
    return targets;
  }

  /** DOIs in batches; the cache answers repeats for 7 days. Returns the error that stopped it, if any. */
  private async enrichByDoi(
    targets: Map<number, Paper>,
    found: Map<number, SourcePaper | undefined>,
    budgetMs: number,
  ): Promise<string | undefined> {
    const { cache } = this.options;
    const uncached: string[] = [];
    for (const p of targets.values()) {
      const doi = doiOf(p);
      if (!doi) continue;
      const hit = cache.get<SourcePaper | null>(`openalex:doi:${doi}`);
      if (hit !== undefined) found.set(p.id, hit ?? undefined);
      else uncached.push(doi);
    }
    if (!uncached.length) return undefined;
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
      return undefined;
    } catch (failure) {
      return failure instanceof Error ? failure.message : String(failure);
    }
  }

  /** Without a DOI: PMID, PMCID or a known OpenAlex ID. Stops at the first error and returns it. */
  private async enrichByOtherIds(
    targets: Map<number, Paper>,
    found: Map<number, SourcePaper | undefined>,
    budgetMs: number,
  ): Promise<string | undefined> {
    const { store, cache } = this.options;
    for (const p of targets.values()) {
      if (doiOf(p)) continue;
      const kind = (["openalex", "pmid", "pmcid"] as const).find((k) => p.ids[k]);
      if (!kind) {
        store.setEnrichment(p.id, "missing"); // nothing OpenAlex can be asked about
        targets.delete(p.id);
        continue;
      }
      try {
        const value = p.ids[kind]!;
        found.set(
          p.id,
          await cache.through(`openalex:${kind}:${value}`, () => this.openalex.lookup(kind, value, budgetMs)),
        );
      } catch (failure) {
        return failure instanceof Error ? failure.message : String(failure);
      }
    }
    return undefined;
  }

  /** Store what OpenAlex found; the rest stays pending for a later search. */
  private applyEnrichment(targets: Map<number, Paper>, found: Map<number, SourcePaper | undefined>) {
    const { store } = this.options;
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
    return { done, pending };
  }
}
