// Usage attribution (spec slots: Usage attribution; design v1-3 D5): add-ons are not benchmarked; each paper source
// is judged by what it brought: the cards created in a period whose paper it returned, and how many you liked.
import type { SourceAttribution } from "@rh/sdk";
import type { Db } from "../db.ts";

export function sourceAttribution(
  db: Db,
  from: string,
  to: string,
  /** The plugin contributing a source id (built-ins: rh.source-<id>), or null when none does. */
  ownerOf: (source: string) => string | null,
): SourceAttribution[] {
  const rows = db
    .prepare(
      `SELECT ps.source, COUNT(DISTINCT c.id) cards,
              COUNT(DISTINCT CASE WHEN j.verdict IN ('up', 'star') THEN c.id END) liked
         FROM cards c JOIN paper_sources ps ON ps.paper_id = c.paper_id
         LEFT JOIN judgments j ON j.card_id = c.id
        WHERE c.created_at >= ? AND c.created_at < ?
        GROUP BY ps.source ORDER BY cards DESC, ps.source`,
    )
    .all(from, to) as { source: string; cards: number; liked: number }[];
  return rows.map((r) => ({
    source: r.source,
    pluginId: ownerOf(r.source),
    cards: Number(r.cards),
    liked: Number(r.liked),
  }));
}
