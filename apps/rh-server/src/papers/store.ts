// Paper records: one row per work, every known identifier, the sources that found it, citation links, and the
// 7-day metadata cache. Results merge only on strong identifiers; a shared normalized title merely flags a
// possible duplicate (spec paper-sources: One record per work).
import { bind, nowIso, VECTOR_KINDS, type Db } from "../db.ts";
import { ID_KINDS, normalizeIds, normalizeTitle, type IdKind, type PaperIds } from "./normalize.ts";

export type BuiltinSourceName = "arxiv" | "openalex" | "europepmc" | "semanticscholar";
/** A built-in source, or one a plugin contributes to papers.source (v1-0). */
export type SourceName = BuiltinSourceName | (string & {});
export const SOURCE_NAMES: readonly BuiltinSourceName[] = ["arxiv", "openalex", "europepmc", "semanticscholar"];
export type Enrichment = "pending" | "done" | "missing";

/** One result as a source client returns it, already normalized. */
export interface SourcePaper {
  source: SourceName;
  externalId: string;
  ids: PaperIds;
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  publishedAt?: string;
  /** Journal or conference name. */
  venue?: string;
  /** Preprint server: arXiv, bioRxiv, medRxiv. */
  server?: string;
  oaUrl?: string;
  url?: string;
  citedByCount?: number;
  referencesCount?: number;
  retracted?: boolean;
  /** Referenced works (OpenAlex IDs) when the source lists them. */
  references?: string[];
  /** arXiv categories ("cs.LG", "q-bio.BM"), primary first. */
  categories?: string[];
}

export interface Paper {
  id: number;
  ids: PaperIds;
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  publishedAt?: string;
  venue?: string;
  server?: string;
  oaUrl?: string;
  url?: string;
  citedByCount?: number;
  referencesCount?: number;
  retracted: boolean;
  enrichment: Enrichment;
  enrichmentAttempts: number;
  /** No abstract: represented from the title alone. */
  titleOnly: boolean;
  possibleDuplicateOf?: number;
  /** arXiv categories, primary first (empty when not from arXiv). */
  categories: string[];
  sources: SourceName[];
  createdAt: string;
  updatedAt: string;
}

export interface UpsertResult {
  id: number;
  created: boolean;
  /** Records folded into this one because the result's identifiers linked them. */
  merged: number[];
}

// Metadata fields where OpenAlex (the enrichment source) is authoritative and overwrites earlier values.
const ENRICHED = ["venue", "cited_by_count", "references_count", "retracted", "oa_url"] as const;

/** Empty columns a new result can fill; OpenAlex, the authority, overwrites the enrichment fields. */
function gapFills(row: PaperRow, sourcePaper: SourcePaper): Record<string, unknown> {
  const authority = sourcePaper.source === "openalex";
  const next: Record<string, unknown> = {};
  const fill = (column: keyof PaperRow, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    const enriched = (ENRICHED as readonly string[]).includes(column);
    if (row[column] === null || (enriched && authority)) next[column] = value;
  };
  fill("venue", sourcePaper.venue);
  fill("server", sourcePaper.server);
  fill("oa_url", sourcePaper.oaUrl);
  fill("url", sourcePaper.url);
  fill("cited_by_count", sourcePaper.citedByCount);
  fill("references_count", sourcePaper.referencesCount);
  // Only the authority can clear a retraction; any source can report one.
  if (sourcePaper.retracted !== undefined && (authority || sourcePaper.retracted))
    next.retracted = sourcePaper.retracted ? 1 : 0;
  if (sourcePaper.categories?.length && !row.categories_json)
    next.categories_json = JSON.stringify(sourcePaper.categories);
  if (!row.title && sourcePaper.title) {
    next.title = sourcePaper.title;
    next.title_norm = normalizeTitle(sourcePaper.title);
  }
  return next;
}

/** Content where the new result is better: the earliest date, the longest abstract, the longer author list. */
function betterContent(row: PaperRow, sourcePaper: SourcePaper): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (sourcePaper.publishedAt && (!row.published_at || sourcePaper.publishedAt < row.published_at)) {
    next.published_at = sourcePaper.publishedAt;
    next.year = Number(sourcePaper.publishedAt.slice(0, 4));
  } else if (!row.year && sourcePaper.year) next.year = sourcePaper.year;
  if (sourcePaper.abstract && sourcePaper.abstract.length > (row.abstract?.length ?? 0))
    next.abstract = sourcePaper.abstract;
  if (sourcePaper.authors.length > (JSON.parse(row.authors_json) as string[]).length)
    next.authors_json = JSON.stringify(sourcePaper.authors);
  return next;
}

export class PaperStore {
  constructor(private readonly db: Db) {}

  /** Store a result: merge into the record owning any of its identifiers, or create one. */
  upsert(input: SourcePaper): UpsertResult {
    const ids = normalizeIds(input.ids);
    const paper = { ...input, ids };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owners = this.ownersOf(ids);
      let result: UpsertResult;
      if (owners.length === 0) result = { id: this.insert(paper), created: true, merged: [] };
      else {
        const [keep, ...others] = owners;
        for (const other of others) this.fold(other, keep);
        this.mergeFields(keep, paper);
        result = { id: keep, created: false, merged: others };
      }
      this.addIds(result.id, ids);
      this.db
        .prepare(
          `INSERT INTO paper_sources (paper_id, source, external_id, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (paper_id, source) DO UPDATE SET external_id = excluded.external_id, fetched_at = excluded.fetched_at`,
        )
        .run(result.id, paper.source, paper.externalId, nowIso());
      if (paper.references) this.setReferences(result.id, paper.references);
      this.flagTitleDuplicate(result.id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: number): Paper | undefined {
    const row = this.db.prepare("SELECT * FROM papers WHERE id = ?").get(id) as PaperRow | undefined;
    return row ? this.toPaper(row) : undefined;
  }

  /** The record owning any of these identifiers (the oldest if several). */
  find(ids: PaperIds): Paper | undefined {
    const [id] = this.ownersOf(normalizeIds(ids));
    return id === undefined ? undefined : this.get(id);
  }

  all(): Paper[] {
    return (this.db.prepare("SELECT * FROM papers ORDER BY id").all() as unknown as PaperRow[]).map((r) =>
      this.toPaper(r),
    );
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM papers").get() as { n: number }).n);
  }

  /** Records whose enrichment is still pending, oldest first. */
  pendingEnrichment(limit = 50): Paper[] {
    return (
      this.db
        .prepare("SELECT * FROM papers WHERE enrichment = 'pending' ORDER BY id LIMIT ?")
        .all(limit) as unknown as PaperRow[]
    ).map((r) => this.toPaper(r));
  }

  /** Record an enrichment attempt; "pending" keeps it eligible for a later retry. */
  setEnrichment(id: number, state: Enrichment): void {
    this.db
      .prepare(
        "UPDATE papers SET enrichment = ?, enrichment_attempts = enrichment_attempts + 1, updated_at = ? WHERE id = ?",
      )
      .run(state, nowIso(), id);
  }

  /** Replace a paper's outgoing citation links with these referenced works (OpenAlex IDs). */
  setReferences(id: number, openalexIds: string[]): void {
    this.db.prepare("DELETE FROM citation_links WHERE citing_paper_id = ?").run(id);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO citation_links (citing_paper_id, cited_kind, cited_value, cited_paper_id)
       VALUES (?, 'openalex', ?, (SELECT paper_id FROM paper_ids WHERE kind = 'openalex' AND value = ?))`,
    );
    for (const raw of openalexIds) {
      const value = normalizeIds({ openalex: raw }).openalex;
      if (value) insert.run(id, value, value);
    }
  }

  // ---- internals ----

  private ownersOf(ids: PaperIds): number[] {
    const owners = new Set<number>();
    const lookup = this.db.prepare("SELECT paper_id FROM paper_ids WHERE kind = ? AND value = ?");
    for (const kind of ID_KINDS) {
      const value = ids[kind];
      if (!value) continue;
      const row = lookup.get(kind, value) as { paper_id: number } | undefined;
      if (row) owners.add(Number(row.paper_id));
    }
    return [...owners].sort((a, b) => a - b);
  }

  private insert(sourcePaper: SourcePaper): number {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO papers (title, title_norm, abstract, authors_json, year, published_at, venue, server, oa_url, url,
           cited_by_count, references_count, retracted, categories_json, created_at, updated_at)
         VALUES (:title, :title_norm, :abstract, :authors_json, :year, :published_at, :venue, :server, :oa_url, :url,
           :cited_by_count, :references_count, :retracted, :categories_json, :now, :now)`,
      )
      .run(
        bind({
          title: sourcePaper.title,
          title_norm: normalizeTitle(sourcePaper.title),
          abstract: sourcePaper.abstract || null,
          authors_json: sourcePaper.authors,
          year: sourcePaper.year ?? (sourcePaper.publishedAt ? Number(sourcePaper.publishedAt.slice(0, 4)) : null),
          published_at: sourcePaper.publishedAt,
          venue: sourcePaper.venue,
          server: sourcePaper.server,
          oa_url: sourcePaper.oaUrl,
          url: sourcePaper.url,
          cited_by_count: sourcePaper.citedByCount,
          references_count: sourcePaper.referencesCount,
          retracted: sourcePaper.retracted ?? false,
          categories_json: sourcePaper.categories?.length ? JSON.stringify(sourcePaper.categories) : null,
          now,
        }),
      );
    return Number(result.lastInsertRowid);
  }

  /** Fill gaps from a new result; OpenAlex overwrites the enrichment fields; the earliest date and longest abstract win. */
  private mergeFields(id: number, sourcePaper: SourcePaper): void {
    const row = this.db.prepare("SELECT * FROM papers WHERE id = ?").get(id) as unknown as PaperRow;
    const next = { ...gapFills(row, sourcePaper), ...betterContent(row, sourcePaper) };
    if (!Object.keys(next).length) return;
    // A title-only paper that gains an abstract is represented again (whole vector from title + abstract, facets).
    if (next.abstract !== undefined && !row.abstract) this.clearRepresentations(id);
    const sets = Object.keys(next).map((k) => `${k} = :${k}`);
    this.db
      .prepare(`UPDATE papers SET ${sets.join(", ")}, updated_at = :updated_at WHERE id = :id`)
      .run(bind({ ...next, updated_at: nowIso(), id }));
  }

  /** Fold record `from` into `into`: identifiers, sources, citations and fields move; `from` is deleted. */
  private fold(from: number, into: number): void {
    const source = this.get(from)!;
    this.db.prepare("UPDATE OR IGNORE paper_ids SET paper_id = ? WHERE paper_id = ?").run(into, from);
    this.db.prepare("UPDATE OR IGNORE paper_sources SET paper_id = ? WHERE paper_id = ?").run(into, from);
    this.db
      .prepare("UPDATE OR IGNORE citation_links SET citing_paper_id = ? WHERE citing_paper_id = ?")
      .run(into, from);
    this.db.prepare("UPDATE citation_links SET cited_paper_id = ? WHERE cited_paper_id = ?").run(into, from);
    this.db.prepare("UPDATE papers SET possible_duplicate_of = ? WHERE possible_duplicate_of = ?").run(into, from);
    this.mergeFields(into, {
      source: "arxiv", // not the authority: only fills gaps
      externalId: "",
      ids: {},
      title: source.title,
      abstract: source.abstract,
      authors: source.authors,
      year: source.year,
      publishedAt: source.publishedAt,
      venue: source.venue,
      server: source.server,
      oaUrl: source.oaUrl,
      url: source.url,
      citedByCount: source.citedByCount,
      referencesCount: source.referencesCount,
      retracted: source.retracted || undefined,
      categories: source.categories,
    });
    if (source.enrichment === "done") this.db.prepare("UPDATE papers SET enrichment = 'done' WHERE id = ?").run(into);
    this.clearRepresentations(from);
    this.db.prepare("DELETE FROM papers WHERE id = ?").run(from);
  }

  private addIds(id: number, ids: PaperIds): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO paper_ids (paper_id, kind, value) VALUES (?, ?, ?)");
    for (const kind of ID_KINDS) {
      const value = ids[kind];
      if (value) insert.run(id, kind, value);
    }
    // Links from known papers to this one become resolved.
    if (ids.openalex)
      this.db
        .prepare("UPDATE citation_links SET cited_paper_id = ? WHERE cited_kind = 'openalex' AND cited_value = ?")
        .run(id, ids.openalex);
  }

  /** Flag (never merge) another record with the same normalized title and no shared identifier. */
  private flagTitleDuplicate(id: number): void {
    const row = this.db.prepare("SELECT title_norm, possible_duplicate_of FROM papers WHERE id = ?").get(id) as {
      title_norm: string;
      possible_duplicate_of: number | null;
    };
    if (row.possible_duplicate_of !== null || row.title_norm.length < 12) return;
    const other = this.db
      .prepare("SELECT id FROM papers WHERE title_norm = ? AND id != ? ORDER BY id LIMIT 1")
      .get(row.title_norm, id) as { id: number } | undefined;
    if (other && Number(other.id) < id)
      this.db.prepare("UPDATE papers SET possible_duplicate_of = ? WHERE id = ?").run(other.id, id);
  }

  private clearRepresentations(id: number): void {
    this.db.prepare("DELETE FROM representations WHERE paper_id = ?").run(id);
    this.db.prepare("DELETE FROM facet_labels WHERE paper_id = ?").run(id);
    for (const kind of VECTOR_KINDS) {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(`vec_${kind}`);
      if (exists) this.db.prepare(`DELETE FROM vec_${kind} WHERE rowid = ?`).run(BigInt(id));
    }
  }

  private toPaper(row: PaperRow): Paper {
    const ids: PaperIds = {};
    for (const r of this.db.prepare("SELECT kind, value FROM paper_ids WHERE paper_id = ?").all(row.id) as {
      kind: IdKind;
      value: string;
    }[])
      ids[r.kind] = r.value;
    const sources = (
      this.db.prepare("SELECT source FROM paper_sources WHERE paper_id = ? ORDER BY rowid").all(row.id) as {
        source: SourceName;
      }[]
    ).map((r) => r.source);
    const opt = <T>(v: T | null) => (v === null ? undefined : v);
    return {
      id: Number(row.id),
      ids,
      title: row.title,
      abstract: opt(row.abstract),
      authors: JSON.parse(row.authors_json) as string[],
      year: opt(row.year),
      publishedAt: opt(row.published_at),
      venue: opt(row.venue),
      server: opt(row.server),
      oaUrl: opt(row.oa_url),
      url: opt(row.url),
      citedByCount: opt(row.cited_by_count),
      referencesCount: opt(row.references_count),
      retracted: !!row.retracted,
      enrichment: row.enrichment,
      enrichmentAttempts: Number(row.enrichment_attempts),
      titleOnly: !row.abstract,
      possibleDuplicateOf: opt(row.possible_duplicate_of),
      categories: row.categories_json ? (JSON.parse(row.categories_json) as string[]) : [],
      sources,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface PaperRow {
  id: number;
  title: string;
  title_norm: string;
  abstract: string | null;
  authors_json: string;
  year: number | null;
  published_at: string | null;
  venue: string | null;
  server: string | null;
  oa_url: string | null;
  url: string | null;
  cited_by_count: number | null;
  references_count: number | null;
  retracted: number;
  enrichment: Enrichment;
  enrichment_attempts: number;
  possible_duplicate_of: number | null;
  categories_json: string | null;
  created_at: string;
  updated_at: string;
}

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** "Not found" answers expire sooner, so a work that is not in OpenAlex yet is asked for again on a later request. */
export const MISS_TTL_MS = 60 * 60 * 1000;

/** Fetched metadata keyed by request (e.g. "openalex:doi:10.1101/…"), kept 7 days (spec: Metadata cache). */
export class MetadataCache {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT body_json, expires_at FROM metadata_cache WHERE key = ?").get(key) as
      | { body_json: string; expires_at: number }
      | undefined;
    if (!row || Number(row.expires_at) <= this.now()) return undefined;
    return JSON.parse(row.body_json) as T;
  }

  set(key: string, body: unknown, ttlMs = CACHE_TTL_MS): void {
    this.db
      .prepare(
        "INSERT INTO metadata_cache (key, body_json, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body_json = excluded.body_json, expires_at = excluded.expires_at",
      )
      .run(key, JSON.stringify(body), this.now() + ttlMs);
  }

  /** Return the cached value or fetch, cache and return it. Misses (`undefined`) are cached for `missTtlMs`. */
  async through<T>(
    key: string,
    fetch: () => Promise<T | undefined>,
    ttlMs = CACHE_TTL_MS,
    missTtlMs = MISS_TTL_MS,
  ): Promise<T | undefined> {
    const row = this.db.prepare("SELECT body_json, expires_at FROM metadata_cache WHERE key = ?").get(key) as
      | { body_json: string; expires_at: number }
      | undefined;
    if (row && Number(row.expires_at) > this.now()) return (JSON.parse(row.body_json) as T | null) ?? undefined;
    const value = await fetch();
    this.set(key, value ?? null, value === undefined ? missTtlMs : ttlMs);
    return value;
  }

  /** Drop expired entries. */
  purge(): number {
    return Number(this.db.prepare("DELETE FROM metadata_cache WHERE expires_at <= ?").run(this.now()).changes);
  }
}
