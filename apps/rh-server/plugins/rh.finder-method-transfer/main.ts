// Built-in finder rh.finder-method-transfer (design v1-7 D2): liked papers with close method vectors and distant
// background vectors.
import { likedPapers, methodTransferLeads } from "../../src/knowledge/finders.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { FinderExports } from "../rh.knowledge/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";

export function activate(context: PluginContext): FinderExports {
  const { db } = hostOf(context);
  const { papers } = context.exports["rh.papers"] as PapersExports;
  return {
    leads: async ({ limit }) =>
      methodTransferLeads(likedPapers(db), (id, kind) => papers.vectors.vector(id, kind), Math.min(3, limit)),
  };
}
