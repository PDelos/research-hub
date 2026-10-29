// Citation links (spec paper-representations: Citation links): from OpenAlex referenced works, the report for a pair
// of papers says whether one cites the other, how many references they share, and how many known papers cite both.
import type { Db } from "../db.ts";

export interface CitationReport {
  aCitesB: boolean;
  bCitesA: boolean;
  sharedReferences: number;
  /** Stored papers whose references include both. */
  coCitedBy: number;
}

export class Citations {
  constructor(private readonly db: Db) {}

  report(paperA: number, paperB: number): CitationReport {
    return {
      aCitesB: this.cites(paperA, paperB),
      bCitesA: this.cites(paperB, paperA),
      sharedReferences: Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) n FROM (SELECT cited_kind, cited_value FROM citation_links WHERE citing_paper_id = ?
               INTERSECT SELECT cited_kind, cited_value FROM citation_links WHERE citing_paper_id = ?)`,
            )
            .get(paperA, paperB) as { n: number }
        ).n,
      ),
      coCitedBy: Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) n FROM (SELECT citing_paper_id FROM citation_links WHERE cited_paper_id = ?
               INTERSECT SELECT citing_paper_id FROM citation_links WHERE cited_paper_id = ?)`,
            )
            .get(paperA, paperB) as { n: number }
        ).n,
      ),
    };
  }

  /** Papers this one cites that are stored in the project. */
  references(paperId: number): number[] {
    return (
      this.db
        .prepare("SELECT cited_paper_id FROM citation_links WHERE citing_paper_id = ? AND cited_paper_id IS NOT NULL")
        .all(paperId) as {
        cited_paper_id: number;
      }[]
    ).map((r) => Number(r.cited_paper_id));
  }

  /** Stored papers that cite this one. */
  citedBy(paperId: number): number[] {
    return (
      this.db.prepare("SELECT citing_paper_id FROM citation_links WHERE cited_paper_id = ?").all(paperId) as {
        citing_paper_id: number;
      }[]
    ).map((r) => Number(r.citing_paper_id));
  }

  private cites(from: number, to: number): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM citation_links WHERE citing_paper_id = ? AND cited_paper_id = ?")
      .get(from, to);
  }
}
