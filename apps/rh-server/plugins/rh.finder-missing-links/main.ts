// Built-in finder rh.finder-missing-links (design v1-7 D2): close liked papers on different questions with no
// citation between them, kept when Jev link-candidate says one could inform the other (at most 5 Jev calls).
import { likedPapers, unlinkedPairs, type Lead } from "../../src/knowledge/finders.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { FinderExports } from "../rh.knowledge/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";

export const LINK_MIN = 0.6;

export function activate(context: PluginContext): FinderExports {
  const { db } = hostOf(context);
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const short = (t: string) => (t.length > 70 ? `${t.slice(0, 67)}…` : t);
  return {
    async leads({ charter, limit }) {
      const question = (id: string | null) => charter.questions.find((q) => q.id === id)?.text ?? "";
      const leads: Lead[] = [];
      for (const pair of unlinkedPairs(db, likedPapers(db), (id, kind) => papers.vectors.vector(id, kind), 5)) {
        const paper = (p: typeof pair.a) => `${p.title}. ${(p.abstract ?? "").slice(0, 1200)}`;
        const { answers } = await context.rh.decisions.decide("link-candidate", {
          paper_a: paper(pair.a),
          paper_b: paper(pair.b),
          question_a: question(pair.a.question),
          question_b: question(pair.b.question),
        });
        const probability = Number((answers.link as { noul?: number } | undefined)?.noul ?? 0);
        if (probability >= LINK_MIN)
          leads.push({
            summary: `“${short(pair.a.title)}” (${pair.a.question}) and “${short(pair.b.title)}” (${pair.b.question}) are close but never cite each other; Jev thinks one could inform the other (${probability.toFixed(2)})`,
            paperIds: [pair.a.id, pair.b.id],
          });
        if (leads.length >= Math.min(3, limit)) break;
      }
      return leads;
    },
  };
}
