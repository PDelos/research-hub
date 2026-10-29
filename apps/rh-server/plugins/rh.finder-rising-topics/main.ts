// Built-in finder rh.finder-rising-topics (design v1-7 D2): words rising in gathered titles, not in the charter.
import { risingTopicLeads } from "../../src/knowledge/finders.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { FinderExports } from "../rh.knowledge/main.ts";

export function activate(context: PluginContext): FinderExports {
  const { db } = hostOf(context);
  return {
    leads: async ({ charter, limit }) => risingTopicLeads(db, JSON.stringify(charter), Date.now(), Math.min(3, limit)),
  };
}
