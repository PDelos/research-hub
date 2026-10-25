// Facet labels by Jev (spec paper-representations: Facet labels by Jev): every abstract sentence is labeled
// background, method, result or other by the versioned `abstract-facets` command in one call per paper; a label
// below the command's min_confidence (0.5) counts as other. Inputs over Jev's 30,000-byte cap drop trailing
// sentences (they count as other).
import {
  inputBytes,
  JevLedger,
  loadCommand,
  MAX_INPUT_BYTES,
  renderCommand,
  type Decide,
  type JevCommand,
} from "@rh/jev";
import type { Db } from "../db.ts";
import { splitSentences } from "../papers/normalize.ts";

export type Facet = "background" | "method" | "result" | "other";
export const FACETS = ["background", "method", "result"] as const;
export type VectorFacet = (typeof FACETS)[number];

export interface FacetLabel {
  index: number;
  sentence: string;
  facet: Facet;
  /** Jev's confidence in its top choice (0 for sentences dropped by the size cap). */
  confidence: number;
  /** The facet Jev chose before the confidence floor (for inspection). */
  chosen?: Facet;
}

export const FACET_COMMAND = "abstract-facets";

export class FacetLabeler {
  readonly command: JevCommand;
  readonly minConfidence: number;

  constructor(private readonly options: { db: Db; jevDir: string; decide: Decide; ledger: JevLedger }) {
    this.command = loadCommand(FACET_COMMAND, options.jevDir);
    this.minConfidence = Number(this.command.policy.min_confidence ?? 0.5);
  }

  get version(): number {
    return this.command.version;
  }

  /** Stored labels for a paper at the current command version, or undefined when it has none. */
  stored(paperId: number): FacetLabel[] | undefined {
    const rows = this.options.db
      .prepare(
        "SELECT sentence_index, sentence, facet, confidence FROM facet_labels WHERE paper_id = ? AND command_version = ? ORDER BY sentence_index",
      )
      .all(paperId, this.version) as { sentence_index: number; sentence: string; facet: Facet; confidence: number }[];
    return rows.length
      ? rows.map((r) => ({
          index: Number(r.sentence_index),
          sentence: r.sentence,
          facet: r.facet,
          confidence: r.confidence,
        }))
      : undefined;
  }

  /** Label a paper's abstract with one Jev call and store the labels (replacing older versions). */
  async label(paper: { id: number; title: string; abstract?: string }): Promise<FacetLabel[]> {
    const sentences = splitSentences(paper.abstract ?? "");
    if (!sentences.length) return [];
    const { included, vars } = this.fit(paper.title, sentences);
    const questions = included.length;
    let labels: FacetLabel[];
    try {
      const rendered = renderCommand(this.command, vars);
      const result = await this.options.decide(rendered.state, rendered.questions, { model: rendered.model });
      this.options.ledger.record(result, {
        command: this.command.name,
        version: this.version,
        extra: { paperId: paper.id },
      });
      labels = sentences.map((sentence, index) => {
        const answer = index < questions ? result.answers[`facet_${index}`] : undefined;
        if (!answer || answer.type !== "choice") return { index, sentence, facet: "other" as Facet, confidence: 0 };
        const chosen = answer.choice as Facet;
        const facet = answer.confidence >= this.minConfidence ? chosen : "other";
        return { index, sentence, facet, confidence: answer.confidence, chosen };
      });
    } catch (error) {
      this.options.ledger.fail(error, {
        command: this.command.name,
        version: this.version,
        questions,
        extra: { paperId: paper.id },
      });
      throw error;
    }
    this.save(paper.id, labels);
    return labels;
  }

  /** Sentences grouped by facet (other excluded). */
  static group(labels: FacetLabel[]): Partial<Record<VectorFacet, string[]>> {
    const out: Partial<Record<VectorFacet, string[]>> = {};
    for (const l of labels) if (l.facet !== "other") (out[l.facet] ??= []).push(l.sentence);
    return out;
  }

  private fit(title: string, sentences: string[]) {
    let included = sentences;
    for (;;) {
      const vars = { title, sentences: included };
      const rendered = renderCommand(this.command, vars);
      if (
        inputBytes({ state: rendered.state, questions: rendered.questions }) <= MAX_INPUT_BYTES ||
        included.length === 1
      )
        return { included, vars };
      included = included.slice(0, -1);
    }
  }

  private save(paperId: number, labels: FacetLabel[]): void {
    const db = this.options.db;
    db.prepare("DELETE FROM facet_labels WHERE paper_id = ?").run(paperId);
    const insert = db.prepare(
      "INSERT INTO facet_labels (paper_id, sentence_index, sentence, facet, confidence, command_version) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const l of labels) insert.run(paperId, l.index, l.sentence, l.facet, l.confidence, this.version);
  }
}
