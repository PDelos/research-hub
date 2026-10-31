// What the hub tells clients about its self-improvement (v1.1–v1.8): digests, the harness, slots and benchmarks,
// the weekly upgrade, the knowledge loop, full text and the engineer.
import type { PluginTopic } from "./plugin-views.ts";

export interface RuleCandidateView {
  reason: string;
  /** How many judgments gave this reason. */
  count: number;
  cards: { cardId: number; title: string }[];
}

export interface CycleStatus {
  lastSweep: { id: number; status: string; cards: number; startedAt: string; endedAt: string | null } | null;
  /** Cards of the last sweep without a judgment yet. */
  waiting: number;
  next: { sweep: string | null; nightly: string | null; review: string | null; timeZone: string };
  lastNightly: { at: string } | null;
  lastDigest: { id: number; week: string; createdAt: string } | null;
}

export type DigestSection =
  | "cycle"
  | "judgments"
  | "exploration"
  | "knowledgeBase"
  | "quality"
  | "sources"
  | "upgrade"
  | "charter"
  | "cost"
  | "changes"
  | "general";

export interface DigestBody {
  week: string;
  from: string;
  to: string;
  cycle: { sweeps: { id: number; status: string; startedAt: string; cards: number }[]; nightlyRuns: number };
  judgments: {
    up: number;
    down: number;
    star: number;
    total: number;
    /** Cards from this week's sweeps still waiting for a judgment. */
    waiting: number;
    precision: { sweepId: number; startedAt: string; judged: number; good: number; precision: number | null }[];
    /**
     * Open rule candidates (v2.0): your reasons that read like general rules, grouped by reason, with how often you
     * gave each and the cards behind it. Present only while the knowledge review (rh.knowledge) is off; read-only.
     */
    ruleCandidates?: RuleCandidateView[];
  };
  exploration: { picks: { sweepId: number; paperId: number; title: string; verdict: string | null }[] };
  knowledgeBase: { added: { stem: string; title: string }[] };
  cost: { modelUsd: number; jevUsd: number; embeddingUsd: number; totalUsd: number };
  changes: { id: string; time: string; message: string; actor: string }[];
  /** What you wrote on the previous digest. */
  lastComments: { section: string; text: string; createdAt: string }[];
  /** What each paper source brought this week (v1.3). */
  sources?: SourceAttribution[];
  /** The week's upgrade runs (v1.4): focus, reason, result, and what was applied or proposed. */
  upgrade?: {
    runs: {
      id: number;
      focus: UpgradeFocus;
      reason: string;
      status: string;
      result: string;
      tried: number;
      proposals: { id: number; kind: string; status: string; commit: string | null }[];
      startedAt: string;
    }[];
  };
  /** The knowledge review (v1.5): charter proposals open now or decided this week. */
  charter?: { proposals: KnowledgeProposal[]; reviewNotes: string[]; finders?: FinderStats[] };
  /** The harness (v1.2): the judge's agreement with you and the week's replays. */
  quality?: {
    judge: { agreement: number | null; cases: number; trusted: boolean } | null;
    replays: {
      id: number;
      variant: Record<string, unknown>;
      verdict: string;
      heldOutDiff: number;
      low: number;
      high: number;
      requestedBy: string;
      createdAt: string;
    }[];
  };
}

export interface DigestComment {
  id: number;
  section: string;
  text: string;
  createdAt: string;
}

export interface DigestView extends DigestBody {
  id: number;
  createdAt: string;
  comments: DigestComment[];
}

export interface DigestSummary {
  id: number;
  week: string;
  from: string;
  to: string;
  createdAt: string;
  comments: number;
}

// ---------------------------------------------------------------- the harness (v1.2)

export interface SweepSettingsView {
  relevanceMin: number;
  worthMin: number;
  rankWeights: { importance: number; relevance: number; question: number; level: number; freshness: number };
  cardsPerSweep: number;
  explorationPicks: number;
}
export type HarnessVariant = Partial<SweepSettingsView>;
export type HarnessVerdict = "better" | "worse" | "inconclusive" | "not enough data";

export interface HarnessMetrics {
  ndcg?: number;
  precision5?: number;
  starRecall?: number;
  coverage: number;
}

export interface ReplayReport {
  variant: HarnessVariant;
  current: SweepSettingsView;
  candidate: SweepSettingsView;
  sweeps: { total: number; labelled: number; heldOut: number };
  perSweep: {
    sweepId: number;
    startedAt: string;
    heldOut: boolean;
    current: HarnessMetrics;
    candidate: HarnessMetrics;
  }[];
  mean: { current: HarnessMetrics; candidate: HarnessMetrics };
  train: { diff: number; n: number };
  heldOut: { diff: number; low: number; high: number; n: number };
  estimated: number;
  judgeUsed: boolean;
  verdict: HarnessVerdict;
}

export interface StoredReplay {
  id: number;
  variant: HarnessVariant;
  requestedBy: string;
  createdAt: string;
  report: ReplayReport;
}

export interface JudgeCalibration {
  cases: number;
  agree: number;
  agreement: number | null;
  kappa: number | null;
  trusted: boolean;
  minAgreement: number;
  minCases: number;
  at: string;
}

export interface HarnessQuality {
  judge: JudgeCalibration | null;
  overTime: ({ sweepId: number; startedAt: string } & HarnessMetrics)[];
  labels: { judged: number; judge: number };
  replays: StoredReplay[];
}

// ---------------------------------------------------------------- slots and benchmarks (v1.3)

export interface BenchmarkResultView {
  tasks: { task: string; metric: string; value: number | null; items: number; note?: string }[];
  value: number | null;
  label: string;
}

export interface BenchmarkRecord {
  id: number;
  slot: string;
  preset: string;
  candidate: Record<string, unknown>;
  result: BenchmarkResultView;
  costUsd: number;
  createdAt: string;
}

export interface SlotView {
  id: string;
  title: string;
  topic: PluginTopic;
  description: string;
  preset: { id: string; title: string; tasks: string[]; metric: string } | null;
  active: { name: string; pluginId: string; detail?: Record<string, unknown> };
  alternatives: { pluginId: string; name: string }[];
  last: BenchmarkRecord | null;
}

export interface SourceAttribution {
  source: string;
  pluginId: string | null;
  cards: number;
  liked: number;
}

// ---------------------------------------------------------------- the weekly upgrade (v1.4)

export type UpgradeFocus = "ranking" | "embedder" | "converter" | "scout-addons";

export interface UpgradeReport {
  focus: UpgradeFocus;
  reason: string;
  analysis?: unknown;
  tried: { what: string; why?: string; verdict?: string; numbers?: Record<string, number | null>; note?: string }[];
  result: string;
}

export interface UpgradeRun {
  id: number;
  focus: UpgradeFocus;
  reason: string;
  status: "running" | "done" | "failed";
  report: UpgradeReport | null;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: string;
}

export interface UpgradeProposal {
  id: number;
  runId: number;
  kind: "ranking" | "embedder" | "converter";
  payload: Record<string, unknown>;
  status: "applied" | "proposed" | "approved" | "rejected";
  commit: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface UpgradeSuggestion {
  id: number;
  runId: number;
  name: string;
  url: string;
  reason: string;
  status: "open" | "dismissed";
  createdAt: string;
}

export interface UpgradesView {
  enabled: boolean;
  everyDays: number;
  running: boolean;
  due: boolean;
  runs: UpgradeRun[];
  proposals: UpgradeProposal[];
  suggestions: UpgradeSuggestion[];
}

// ---------------------------------------------------------------- the knowledge loop (v1.5)

export interface KnowledgeChange {
  kind: "weight" | "retire-question" | "drop-query" | "add-question" | "add-out-of-scope" | "level" | "taste-rule";
  target?: string;
  targetKind?: "question" | "query";
  from?: number;
  to?: number;
  text?: string;
  queries?: string[];
  topic?: string;
  level?: { from: string; to: string };
  rule?: string;
  candidateIds?: number[];
}

/** What a question finder brought (v1.7): its proposals and what came of them. */
export interface FinderStats {
  finder: string;
  title: string;
  proposed: number;
  approved: number;
  rejected: number;
  /** 👍/⭐ cards matched to its approved questions since approval. */
  liked: number;
}

export interface KnowledgeProposal {
  id: number;
  reviewId: number;
  kind: KnowledgeChange["kind"];
  change: KnowledgeChange;
  title: string;
  evidence: {
    summary: string;
    papers: { id: number; title: string; verdict: string | null; reason?: string | null }[];
    score?: number;
  };
  status: "proposed" | "approved" | "rejected" | "stale" | "undone";
  /** For a new question: the finder it came from (or "interests"). */
  finder: string | null;
  baseVersion: number;
  appliedVersion: number | null;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface KnowledgeReview {
  id: number;
  requestedBy: string;
  report: {
    charterVersion: number | null;
    rules: number;
    directions: { question: string; score: number | null; kept: boolean; note?: string }[];
    outOfScope: { topic: string; kept: boolean; note?: string }[];
    proposals: number[];
    notes: string[];
  };
  costUsd: number;
  createdAt: string;
}

export interface KnowledgeView {
  running: boolean;
  reviews: KnowledgeReview[];
  proposals: KnowledgeProposal[];
  finders: FinderStats[];
}

// ---------------------------------------------------------------- full text (v1.6)

export interface FullTextView {
  paperId: number;
  /** none: never fetched. */
  status: "ok" | "missing" | "none";
  source: string | null;
  sections: { title: string; text: string }[];
  chars: number;
  notes: string[];
  fetchedAt: string | null;
}

export interface ConverterInfo {
  id: string;
  title: string;
  pluginId: string;
  active: boolean;
  available: boolean;
  reason?: string;
}

// ---------------------------------------------------------------- the engineer (v1.8)

export interface EngineerIdea {
  id: number;
  source: "suggestion" | "user" | "slot";
  text: string;
  stage: "researching" | "assessed" | "building" | "proposed" | "installed" | "rejected" | "failed" | "not-buildable";
  assessment: {
    worth: boolean;
    kind: "paper-source" | "embedder-finetune" | "other";
    gain: string;
    cost: string;
    risk: string;
    plan: string;
    api?: { baseUrl?: string; docsUrl?: string; name?: string };
    citations?: { url: string; title?: string }[];
  } | null;
  pluginId: string | null;
  log: { at: string; text: string }[];
  numbers: Record<string, unknown> | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}
