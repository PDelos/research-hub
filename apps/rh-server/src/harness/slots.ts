// The slots (spec slots: Slot catalog; EVOLUTION.md §0.1): the parts of the hub that may be replaced, one active at a
// time, and the fixed benchmark preset each is judged on. Core: plugins and upgrades cannot change this list.
import type { PluginTopic } from "../kernel/manifest.ts";

export interface PresetInfo {
  id: string;
  title: string;
  tasks: string[];
  metric: string;
}

export interface SlotInfo {
  id: string;
  title: string;
  topic: PluginTopic;
  description: string;
  preset: PresetInfo | null;
}

export const PRESETS: Record<string, PresetInfo> = {
  ranking: {
    id: "ranking",
    title: "Replays on your judgments",
    tasks: ["past sweeps re-ranked, latest 30 % held out"],
    metric: "nDCG difference with a 95 % interval",
  },
  embedder: {
    id: "embedder",
    title: "SCIDOCS, LitSearch, your stars",
    tasks: ["scidocs", "litsearch", "your-stars"],
    metric: "nDCG@10",
  },
  facets: {
    id: "facets",
    title: "PubMed 20k RCT",
    tasks: ["pubmed-rct"],
    metric: "macro-F1 over background, method, result",
  },
  judge: { id: "judge", title: "Agreement with you", tasks: ["your judged cards"], metric: "agreement (and kappa)" },
};

export const SLOTS: SlotInfo[] = [
  {
    id: "ranking",
    title: "Ranking and gating",
    topic: "finding",
    description: "Which found papers become cards: gate thresholds, rank weights, cards per sweep, exploration picks.",
    preset: PRESETS.ranking,
  },
  {
    id: "embedder",
    title: "Embedder",
    topic: "understanding",
    description: "Turns papers into vectors for similarity, exploration and search.",
    preset: PRESETS.embedder,
  },
  {
    id: "facets",
    title: "Facet labeler",
    topic: "understanding",
    description: "Labels each abstract sentence as background, method or result.",
    preset: PRESETS.facets,
  },
  {
    id: "judge",
    title: "Judge",
    topic: "ranking",
    description: "Estimates whether you would like papers you never judged (used only when calibrated).",
    preset: PRESETS.judge,
  },
  {
    id: "kb-search",
    title: "Knowledge-base search",
    topic: "knowledge",
    description: "Finds notes in your knowledge base for the desk and the Library.",
    preset: null,
  },
  {
    id: "models",
    title: "Models per job",
    topic: "agents",
    description: "The language models of the desk, the card writer and the librarian.",
    preset: null,
  },
];
