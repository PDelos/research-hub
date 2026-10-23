// The project's paper facade (design D1): search across sources, store, enrich, and represent what was found; vector
// and citation queries; background re-embedding after a model change.
import type { Decide, JevLedger } from "@rh/jev";
import type { PapersConfig } from "../config.ts";
import type { Db, Settings } from "../db.ts";
import type { Logger } from "../logger.ts";
import { Citations } from "../representations/citations.ts";
import { EmbeddingLedger, FakeEmbedder, OpenRouterEmbedder, type Embedder } from "../representations/embed.ts";
import { FacetLabeler } from "../representations/facets.ts";
import { PaperVectors, type RepresentResult } from "../representations/vectors.ts";
import { PoliteHttp } from "./http.ts";
import { offlinePaperFetch } from "./offline.ts";
import { PaperSearch, type SearchRequest, type SearchResult } from "./search.ts";
import { MetadataCache, PaperStore } from "./store.ts";

export interface FindResult extends SearchResult {
  represented: RepresentResult;
}

export interface PaperServiceOptions {
  db: Db;
  settings: Settings;
  config: PapersConfig;
  offline: boolean;
  openrouterKey?: string;
  jevDir: string;
  decide: Decide;
  jevLedger: JevLedger;
  log: Logger;
  /** Overrides for tests: the fetch used by paper sources (and live embeddings), or the embedder. */
  fetch?: typeof fetch;
  embedder?: Embedder;
}

export class PaperService {
  readonly store: PaperStore;
  readonly cache: MetadataCache;
  readonly search: PaperSearch;
  readonly facets: FacetLabeler;
  readonly vectors: PaperVectors;
  readonly citations: Citations;
  readonly embeddingLedger: EmbeddingLedger;
  private catchingUp?: Promise<void>;
  private closed = false;

  constructor(private readonly options: PaperServiceOptions) {
    const { db, config, offline, log } = options;
    this.store = new PaperStore(db);
    this.cache = new MetadataCache(db);
    this.embeddingLedger = new EmbeddingLedger(db);
    const http = new PoliteHttp({
      fetch: options.fetch ?? (offline ? offlinePaperFetch() : undefined),
      contactEmail: config.contactEmail,
      log,
      ...(offline && !options.fetch ? { pacing: { "export.arxiv.org": 0 } } : {}),
    });
    this.search = new PaperSearch({ store: this.store, cache: this.cache, http, s2ApiKey: offline ? undefined : config.s2ApiKey, log });
    const embedder =
      options.embedder ??
      (offline || !options.openrouterKey
        ? new FakeEmbedder(config.embedDims, this.embeddingLedger)
        : new OpenRouterEmbedder({
            apiKey: options.openrouterKey,
            model: config.embedModel,
            dims: config.embedDims,
            ledger: this.embeddingLedger,
            http: new PoliteHttp({ fetch: options.fetch, log }),
          }));
    this.facets = new FacetLabeler({ db, jevDir: options.jevDir, decide: options.decide, ledger: options.jevLedger });
    this.vectors = new PaperVectors({ db, settings: options.settings, store: this.store, embedder, facets: this.facets, log });
    this.citations = new Citations(db);
    this.vectors.syncModel();
  }

  /** Search, store, enrich and represent: the records found are ready for similarity search on return. */
  async find(request: SearchRequest): Promise<FindResult> {
    const result = await this.search.search(request);
    let represented: RepresentResult = { represented: 0, skipped: 0, facetFailures: 0 };
    try {
      represented = await this.vectors.represent(result.papers.map((p) => p.id));
    } catch (error) {
      // Records are stored either way; missing vectors are filled by the next call or the background catch-up.
      this.options.log.warn("representations.failed", { error: error instanceof Error ? error.message : String(error) });
    }
    return { ...result, represented };
  }

  /** Re-embed papers without current vectors in the background (after a model change). */
  start(): void {
    if (this.catchingUp || !this.vectors.pending()) return;
    const pending = this.vectors.pending();
    this.options.log.info("representations.catch_up_started", { pending, model: this.vectors.model });
    this.catchingUp = (async () => {
      try {
        while (!this.closed) {
          const ids = this.vectors.pendingIds(32);
          if (!ids.length) break;
          const result = await this.vectors.represent(ids);
          if (!result.represented) break;
        }
        this.options.log.info("representations.catch_up_done", { pending: this.vectors.pending() });
      } catch (error) {
        this.options.log.warn("representations.catch_up_failed", { error: error instanceof Error ? error.message : String(error), pending: this.vectors.pending() });
      }
    })();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.catchingUp;
  }
}
