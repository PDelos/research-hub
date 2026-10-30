// Paper vectors (spec paper-representations): a whole-paper vector from title + abstract and one vector per facet
// (background, method, result) from that facet's sentences, all from the one configured embedding model, stored in
// sqlite-vec tables (rowid = paper id) and computed at most once per model and facet-command version. Similarity is
// cosine KNN on L2-normalized vectors. A model or dimension change clears every vector (never compared across
// models) and re-embeds in the background.
import { VECTOR_KINDS, ensureVectorTables, nowIso, type Db, type Settings, type VectorKind } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { Paper, PaperStore } from "../papers/store.ts";
import type { Embedder } from "./embed.ts";
import { FacetLabeler, FACETS, type FacetLabel } from "./facets.ts";

export const SIMILAR_K_DEFAULT = 8;
const FACET_LANES = 5;
const MODEL_SETTING = "embedding_model";

export interface RepresentResult {
  represented: number;
  skipped: number;
  /** Papers whose facet labeling failed (whole vector stored; facets retried next time). */
  facetFailures: number;
}

export interface SimilarHit {
  paperId: number;
  /** Cosine distance (0 = same direction, 2 = opposite) on the requested vector. */
  distance: number;
  /** For facet searches: distance between the two papers' background vectors, when both have one. */
  backgroundDistance?: number;
  /** For facet searches: distance between the whole-paper vectors. */
  wholeDistance?: number;
}

export class PaperVectors {
  constructor(
    private readonly options: {
      db: Db;
      settings: Settings;
      store: PaperStore;
      embedder: Embedder;
      facets: FacetLabeler;
      log?: Logger;
    },
  ) {}

  /** Facet texts from a paper's full text (v1-6): when given, they replace the abstract's labeled sentences. */
  private fullTextFacets?: (paperId: number) => Partial<Record<(typeof FACETS)[number], string>> | undefined;

  setFullTextFacets(
    provider: ((paperId: number) => Partial<Record<(typeof FACETS)[number], string>> | undefined) | undefined,
  ): void {
    this.fullTextFacets = provider;
  }

  /** Recompute one paper's vectors now (e.g. after its full text arrived). */
  async refresh(paperId: number): Promise<RepresentResult> {
    this.options.db.prepare("DELETE FROM representations WHERE paper_id = ?").run(paperId);
    return this.represent([paperId]);
  }

  get model(): string {
    return this.options.embedder.model;
  }

  /**
   * Make sure stored vectors belong to the configured model and dimension. On a change every vector is cleared
   * (facet labels are kept: they do not depend on the embedding model). Returns true when vectors were cleared.
   */
  syncModel(): boolean {
    const { db, settings, embedder } = this.options;
    const current = { model: embedder.model, dims: embedder.dims };
    const saved = settings.get<{ model: string; dims: number } | null>(MODEL_SETTING, null);
    const stale = (
      db
        .prepare("SELECT COUNT(*) n FROM representations WHERE model != ? OR dims != ?")
        .get(current.model, current.dims) as { n: number }
    ).n;
    if (saved && saved.model === current.model && saved.dims === current.dims && !stale) return false;
    const hadVectors = (db.prepare("SELECT COUNT(*) n FROM representations").get() as { n: number }).n > 0;
    if (!ensureVectorTables(db, current.dims)) for (const kind of VECTOR_KINDS) db.exec(`DELETE FROM vec_${kind}`);
    db.exec("DELETE FROM representations");
    settings.set(MODEL_SETTING, current);
    if (hadVectors)
      this.options.log?.info("representations.model_changed", { from: saved, to: current, pending: this.pending() });
    return hadVectors;
  }

  /** Papers without a whole-paper vector from the current model. */
  pending(): number {
    return Number(
      (
        this.options.db
          .prepare(
            "SELECT COUNT(*) n FROM papers p WHERE NOT EXISTS (SELECT 1 FROM representations r WHERE r.paper_id = p.id AND r.kind = 'whole' AND r.model = ?)",
          )
          .get(this.model) as { n: number }
      ).n,
    );
  }

  pendingIds(limit = 64): number[] {
    return (
      this.options.db
        .prepare(
          "SELECT id FROM papers p WHERE NOT EXISTS (SELECT 1 FROM representations r WHERE r.paper_id = p.id AND r.kind = 'whole' AND r.model = ?) ORDER BY id LIMIT ?",
        )
        .all(this.model, limit) as { id: number }[]
    ).map((r) => Number(r.id));
  }

  /** True when the paper needs no work: whole vector from this model and (unless title-only) labels at this version. */
  isCurrent(paper: Paper): boolean {
    const whole = this.options.db
      .prepare("SELECT 1 FROM representations WHERE paper_id = ? AND kind = 'whole' AND model = ? AND dims = ?")
      .get(paper.id, this.model, this.options.embedder.dims);
    return !!whole && (paper.titleOnly || !!this.options.facets.stored(paper.id));
  }

  /** Represent these papers: label facets (one Jev call each) and embed every text in batched calls. */
  async represent(ids: number[]): Promise<RepresentResult> {
    const { papers, skipped } = this.stalePapers(ids);
    const { labeled, facetFailures } = await this.labelAll(papers);
    const todo = papers.map((paper) => ({ paper, labels: labeled.get(paper.id) ?? [] }));
    if (!todo.length) return { represented: 0, skipped, facetFailures };
    const { texts, slots } = this.embeddingTexts(todo);
    this.saveVectors(
      todo.map(({ paper }) => paper.id),
      slots,
      await this.options.embedder.embed(texts),
    );
    return { represented: todo.length, skipped, facetFailures };
  }

  /** The known papers among `ids` whose vectors are missing or from another model; the rest count as skipped. */
  private stalePapers(ids: number[]): { papers: Paper[]; skipped: number } {
    const papers: Paper[] = [];
    let skipped = 0;
    for (const id of new Set(ids)) {
      const paper = this.options.store.get(id);
      if (!paper) continue;
      if (this.isCurrent(paper)) skipped++;
      else papers.push(paper);
    }
    return { papers, skipped };
  }

  /** Facet labels: one Jev call per paper, five at a time; stored labels are reused, a failure leaves none. */
  private async labelAll(papers: Paper[]) {
    const { facets } = this.options;
    const labeled = new Map<number, FacetLabel[]>();
    let facetFailures = 0;
    const label = async (paper: Paper) => {
      if (paper.titleOnly) return void labeled.set(paper.id, []);
      try {
        labeled.set(paper.id, facets.stored(paper.id) ?? (await facets.label(paper)));
      } catch (error) {
        facetFailures++;
        labeled.set(paper.id, []);
        this.options.log?.warn("representations.facets_failed", {
          paperId: paper.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    await Promise.all(
      Array.from({ length: FACET_LANES }, async (_, lane) => {
        for (let k = lane; k < papers.length; k += FACET_LANES) await label(papers[k]);
      }),
    );
    return { labeled, facetFailures };
  }

  /** One text per vector: title and abstract for the whole paper, then each facet (full-text sections first). */
  private embeddingTexts(todo: { paper: Paper; labels: FacetLabel[] }[]) {
    const texts: string[] = [];
    const slots: { paperId: number; kind: VectorKind }[] = [];
    for (const { paper, labels } of todo) {
      texts.push(paper.titleOnly ? paper.title : `${paper.title}\n\n${paper.abstract}`);
      slots.push({ paperId: paper.id, kind: "whole" });
      const groups = FacetLabeler.group(labels);
      const full = this.fullTextFacets?.(paper.id);
      for (const facet of FACETS) {
        const text = full?.[facet] ?? groups[facet]?.join(" ");
        if (!text) continue;
        texts.push(text);
        slots.push({ paperId: paper.id, kind: facet });
      }
    }
    return { texts, slots };
  }

  /** Replace these papers' vectors in one transaction. */
  private saveVectors(paperIds: number[], slots: { paperId: number; kind: VectorKind }[], vectors: Float32Array[]) {
    const { db, embedder } = this.options;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const paperId of paperIds) {
        db.prepare("DELETE FROM representations WHERE paper_id = ?").run(paperId);
        for (const kind of VECTOR_KINDS) db.prepare(`DELETE FROM vec_${kind} WHERE rowid = ?`).run(BigInt(paperId));
      }
      const now = nowIso();
      slots.forEach((slot, i) => {
        db.prepare(`INSERT INTO vec_${slot.kind} (rowid, embedding) VALUES (?, ?)`).run(
          BigInt(slot.paperId),
          vectors[i],
        );
        db.prepare("INSERT INTO representations (paper_id, kind, model, dims, created_at) VALUES (?, ?, ?, ?, ?)").run(
          slot.paperId,
          slot.kind,
          embedder.model,
          embedder.dims,
          now,
        );
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Re-embed papers missing current vectors, a batch at a time (after a model change). */
  async catchUp(batch = 64): Promise<number> {
    let done = 0;
    for (;;) {
      const ids = this.pendingIds(batch);
      if (!ids.length) return done;
      const result = await this.represent(ids);
      done += result.represented;
      if (!result.represented) return done;
    }
  }

  /** Which vectors a paper has. */
  kinds(paperId: number): VectorKind[] {
    return (
      this.options.db
        .prepare("SELECT kind FROM representations WHERE paper_id = ? AND model = ? ORDER BY kind")
        .all(paperId, this.model) as {
        kind: VectorKind;
      }[]
    ).map((r) => r.kind);
  }

  vector(paperId: number, kind: VectorKind): Float32Array | undefined {
    const row = this.options.db.prepare(`SELECT embedding FROM vec_${kind} WHERE rowid = ?`).get(BigInt(paperId)) as
      | { embedding: Uint8Array }
      | undefined;
    if (!row) return undefined;
    const bytes = row.embedding;
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  /**
   * The k papers most similar to a paper or a text, by the whole vector or one facet. A facet search from a paper
   * also reports each hit's background and whole distances, so "same method, different problem" stands out.
   */
  async similar(
    from: { paperId: number } | { text: string },
    options: { by?: VectorKind; k?: number } = {},
  ): Promise<SimilarHit[]> {
    const by = options.by ?? "whole";
    const count = options.k ?? SIMILAR_K_DEFAULT;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new RangeError(`k must be 1 to 100, got ${count}`);
    const self = "paperId" in from ? from.paperId : undefined;
    const query =
      "paperId" in from ? this.vector(from.paperId, by) : (await this.options.embedder.embed([from.text]))[0];
    if (!query) return [];
    const rows = this.options.db
      .prepare(`SELECT rowid, distance FROM vec_${by} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
      .all(query, count + (self === undefined ? 0 : 1)) as { rowid: number | bigint; distance: number }[];
    const hits = rows
      .map((r) => ({ paperId: Number(r.rowid), distance: r.distance }))
      .filter((h) => h.paperId !== self)
      .slice(0, count) as SimilarHit[];
    if (self !== undefined && by !== "whole") this.addContextDistances(self, hits);
    return hits;
  }

  /** Each hit's background and whole distance from the paper, beside the facet distance it was found by. */
  private addContextDistances(paperId: number, hits: SimilarHit[]) {
    const background = this.vector(paperId, "background");
    const whole = this.vector(paperId, "whole");
    for (const hit of hits) {
      const otherBackground = background && this.vector(hit.paperId, "background");
      if (background && otherBackground) hit.backgroundDistance = cosineDistance(background, otherBackground);
      const otherWhole = whole && this.vector(hit.paperId, "whole");
      if (whole && otherWhole) hit.wholeDistance = cosineDistance(whole, otherWhole);
    }
  }
}

export function cosineDistance(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    na += left[i] * left[i];
    nb += right[i] * right[i];
  }
  return na && nb ? 1 - dot / Math.sqrt(na * nb) : 1;
}
