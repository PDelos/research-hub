// Built-in plugin rh.papers: the paper facade (search, store, enrichment, representations). It offers the
// papers.source, papers.enricher and papers.embedder extension points: a search queries the sources whose plugins
// are enabled, and vectors come from the active embedder plugin.
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { PaperService } from "../../src/papers/service.ts";
import { paperTools } from "../../src/papers/tool.ts";
import type { PaperSource } from "../../src/papers/sources/types.ts";
import { SOURCE_NAMES } from "../../src/papers/store.ts";
import type { Embedder, EmbeddingLedger } from "../../src/representations/embed.ts";
import type { DecisionExports } from "../rh.decision-jev/main.ts";

/** What a plugin contributing papers.embedder exports. */
export interface EmbedderExports {
  createEmbedder(context: { ledger: EmbeddingLedger }): Embedder;
}

/** What a plugin contributing a non-built-in papers.source exports: a client per contributed id. */
export interface SourceExports {
  sources?: Record<string, PaperSource>;
}

export interface PapersExports extends AgentHooks {
  papers: PaperService;
}

const BUILTIN_SOURCES = new Set<string>(SOURCE_NAMES);

export async function activate(context: PluginContext): Promise<PapersExports> {
  const host = hostOf(context);
  const { options } = host;
  const jev = context.exports["rh.decision-jev"] as DecisionExports;
  const { contributions } = host.services;

  const choice = contributions.activeContribution("papers.embedder", context.settings);
  if (!choice) throw new Error("no plugin contributing papers.embedder is enabled");
  const embedder = await host.exportsOf<EmbedderExports>(choice.pluginId);

  const papers = new PaperService({
    db: host.db,
    settings: host.settings,
    config: options.papers,
    offline: options.offline,
    openrouterKey: options.openrouterKey,
    jevDir: jev.jevDir,
    decide: jev.decide,
    jevLedger: jev.ledger,
    log: host.log,
    fetch: options.paperFetch,
    embedder: (c) => embedder.createEmbedder(c),
    async selectedSources() {
      const sources = await contributions.contributionsTo("papers.source", { activate: true });
      const extra: PaperSource[] = [];
      for (const s of sources.filter((x) => !BUILTIN_SOURCES.has(x.id))) {
        const client = (await host.exportsOf<SourceExports>(s.pluginId)).sources?.[s.id];
        if (client) extra.push(client);
        else context.log.warn("papers.source_missing", { plugin: s.pluginId, source: s.id });
      }
      const enrichers = await contributions.contributionsTo("papers.enricher", { activate: true });
      return {
        builtin: new Set(sources.filter((x) => BUILTIN_SOURCES.has(x.id)).map((x) => x.id)),
        extra,
        enrich: enrichers.some((e) => e.id === "openalex"),
      };
    },
  });
  context.subscriptions.push({ dispose: () => papers.close() });
  return { papers, agentExtensions: [paperTools(() => papers)], ready: () => papers.start() };
}
