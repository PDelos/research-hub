// The server-sent event frames of GET /v1/p/:slug/stream and the API shapes clients read.
// hello → agent.snapshot → agent.batch… plus agent.state and usage whenever they change.
import type { WireAgentEvent, WireSnapshotEvent } from "./wire.ts";

export const API_VERSION = 1;

export interface AgentState {
  project: string;
  conversationId: number;
  model: string;
  contextTokens: number;
  contextWindow: number;
  busy: boolean;
  compaction: { background: number; force: number; enabled: boolean; window: number };
}

export interface CostTotals {
  modelUsd: number;
  jevUsd: number;
  jevUnknownCalls: number;
  totalUsd: number;
  monthUsd: number;
  runs: number;
  jevCalls: number;
  /** Paper embeddings (v0.2); facet labeling is counted under Jev. */
  embeddingUsd: number;
  embeddingCalls: number;
}

export interface RunSummary {
  id: number;
  conversationId: number;
  text: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  models: string[];
  generations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunDetail extends RunSummary {
  generationList: {
    entryId: number;
    model: string | null;
    stopReason: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number | null;
    text: string | null;
  }[];
  toolCallList: {
    id: number;
    toolName: string;
    status: string;
    isError: boolean;
    args: unknown;
    result: string | null;
    durationMs: number | null;
  }[];
}

export interface Health {
  ok: boolean;
  /** The research project this container serves. */
  project: string;
  version: string;
  mode: "live" | "offline";
  providers: { models: string; jev: string };
}

export interface Info extends Health {
  piDurable: string;
  models: Record<string, string>;
  jevModel: string;
  uptimeMs: number;
  kbViewer: KbViewerStatus;
  /** The kernel API version plugins are checked against (v1.0). */
  kernelApi: string;
  /** Every plugin with its version and state (v1.0). */
  plugins: { id: string; version: string; state: PluginRunState }[];
}

export interface KbViewerStatus {
  state: "disabled" | "unavailable" | "starting" | "running" | "crashed";
  reason?: string;
  ignisVersion?: string;
  obsidianVersion: string;
  restarts: number;
}

export interface SendResult {
  submissionId: number;
  status: "queued" | "pending" | "done" | "unanswered";
  answer?: { entryId: number; text: string };
  reason?: string;
}

export interface JevPing {
  provider: string;
  model: string;
  elapsedMs: number;
  cost: { amount: number | null; source: string };
  greeting: number;
}

export type Frame =
  | { type: "hello"; apiVersion: number; serverTime: number; project: string; mainConversationId: number }
  | { type: "agent.snapshot"; conversationId: number; snapshot: WireSnapshotEvent }
  | { type: "agent.batch"; conversationId: number; events: WireAgentEvent[] }
  | { type: "agent.state"; state: AgentState }
  | { type: "usage"; totals: CostTotals }
  | { type: "cards"; count: number; latestCardId: number | null; judged: number; sweep: SweepSummary | null }
  | { type: "plugins"; plugins: PluginSummary[] };

// ---------------------------------------------------------------- plugins (v1.0)

/** active: running; inactive: enabled, waiting for an activation event; blocked: a dependency is not available. */
export type PluginRunState = "active" | "activating" | "inactive" | "disabled" | "failed" | "incompatible" | "blocked";

export interface PluginPermissionsView {
  network?: string[];
  files?: string[];
  secrets?: string[];
  budgetUsdPerDay?: number;
}

export interface PluginContributionsDetail {
  tabs: { id: string; title: string; view: string; order?: number }[];
  commands: { id: string; title: string }[];
  chatTools: { name: string; description: string; desk?: boolean }[];
  jevCommands: string[];
  prompts: { agent: string; path: string }[];
  processes: { id: string; title?: string; entry: string }[];
  extensionPoints: Record<string, { description?: string; cardinality: "one" | "many"; default?: string }>;
  /** Contributions to extension points other plugins offer, by point. */
  points: Record<string, { id: string; [field: string]: unknown }[]>;
}

export interface PluginSettingProperty {
  type?: string;
  description?: string;
  default?: unknown;
  env?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface PluginHistoryEntry {
  id: string;
  time: string;
  message: string;
  /** user, kernel, or proposal:<id> */
  actor: string;
}

export interface PluginDetails extends PluginSummary {
  engines: string;
  activationEvents: string[];
  dependencies: Record<string, string>;
  /** Enabled plugins that depend on this one (disabling asks first). */
  dependents: string[];
  required: boolean;
  permissions: PluginPermissionsView;
  contributions: PluginContributionsDetail;
  settings: { properties: Record<string, PluginSettingProperty>; values: Record<string, unknown> };
  /** Problems that do not stop the plugin (unknown extension points, names taken by another plugin). */
  problems: string[];
  /** Changes that mention this plugin, newest first. */
  history: PluginHistoryEntry[];
}

export interface PluginList {
  kernelApi: string;
  plugins: PluginSummary[];
  /** Plugin folders whose manifest is invalid, with the problems. */
  invalid: { dir: string; problems: string[] }[];
}

export interface PluginTabView {
  id: string;
  title: string;
  view: string;
  order?: number;
  pluginId: string;
  builtin: boolean;
  /** External plugins: the module to load (it defines the custom element named by `view`). */
  script?: string;
}

export interface PluginContributionsView {
  tabs: PluginTabView[];
  /** The kb.viewer extension point: what the Knowledge base tab shows. */
  viewer: {
    active: { id: string; title: string; view: string; pluginId: string } | null;
    options: { id: string; title: string; pluginId: string }[];
  };
  /** Settings of every available plugin that declares any, grouped by plugin. */
  settings: {
    pluginId: string;
    displayName: string;
    properties: Record<string, PluginSettingProperty>;
    values: Record<string, unknown>;
  }[];
}

export type PluginInstallSource = { folder: string } | { git: string; ref?: string };

export interface PluginInstallPlan {
  planId: string;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  replaces?: string;
  source: { kind: string; path?: string; url?: string; ref?: string };
  permissions: PluginPermissionsView;
  contributions: PluginContributionsDetail;
}

export interface PluginSummary {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  builtin: boolean;
  state: PluginRunState;
  /** Why the plugin is not active (blocked, incompatible) or the error that made it fail. */
  reason?: string;
  activatedAt?: string;
}

// ---------------------------------------------------------------- project, charter, schedule (v0.1)

export type ProjectStatus = "needs-brief" | "charter-review" | "active" | "paused";

export interface ProjectOverview {
  name: string;
  status: ProjectStatus;
  charterVersion: number | null;
  hasDraft: boolean;
  charterRun: "running" | "done" | "failed" | null;
  paused: { since: string } | null;
  /** review is the weekly digest; nightly is the cycle's nightly run (v1.1). */
  next: { sweep: string | null; nightly: string | null; review: string | null; timeZone: string };
  monthCostUsd: number;
}

export interface CharterBody {
  questions: { id: string; text: string; weight: number }[];
  concepts: string[];
  subAreas: string[];
  queries: { text: string; weight: number }[];
  outOfScope: string[];
}

export interface CharterRecord {
  id: number;
  status: "draft" | "approved" | "superseded";
  version: number | null;
  charter: CharterBody;
  source: "agent" | "user";
  createdAt: string;
  approvedAt: string | null;
}

export interface ScopingQuestion {
  id: number;
  round: number;
  text: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface CharterView {
  status: ProjectStatus;
  draft: CharterRecord | null;
  approved: CharterRecord | null;
  versions: { version: number; approvedAt: string; source: string }[];
  questions: ScopingQuestion[];
  questionsLeft: number;
  run: {
    id: number;
    kind: "draft" | "revision";
    status: "running" | "done" | "failed";
    reason?: string;
    invalidSaves: number;
    startedAt: string;
    endedAt?: string;
  } | null;
}

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface ScheduleSettings {
  timeZone: string;
  sweep: { enabled: boolean; time: string };
  /** The nightly run of the daily cycle (v1.1). */
  nightly: { enabled: boolean; time: string };
  /** The weekly digest (stored as the review kind). */
  review: { enabled: boolean; weekday: Weekday; time: string };
}

export type RunKind = "sweep" | "nightly" | "review";

export interface ScheduledRun {
  id: number;
  kind: RunKind;
  slot: string;
  slotAt: number | null;
  trigger: "scheduled" | "manual";
  status: "requested" | "running" | "done" | "failed" | "skipped";
  reason: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- sweeps and cards (v0.3)

export type SweepPhase = "plan" | "gather" | "dedupe" | "gate" | "enrich" | "level" | "rank" | "cards";
export type SweepStatus = "running" | "completed" | "no_new_papers" | "failed";

export interface SweepCost {
  jevUsd: number;
  jevCalls: number;
  embeddingUsd: number;
  embeddingCalls: number;
  modelUsd: number;
  totalUsd: number;
}

export interface SweepPhaseRecord {
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt?: string;
  attempts: number;
  counts?: Record<string, number>;
  error?: string;
  detail?: unknown;
}

export interface SweepSummary {
  id: number;
  trigger: string;
  status: SweepStatus;
  phase: SweepPhase;
  orientation: boolean;
  counts: Record<string, number>;
  error?: string;
  nextRetryAt?: number;
  cost?: SweepCost;
  cards: number;
  startedAt: string;
  endedAt?: string;
}

export interface SweepPaperView {
  paperId: number;
  title: string;
  status: string;
  reason?: string;
  borderline: boolean;
  /** An exploration pick: least like the papers you liked (v1.1). */
  exploration: boolean;
  relevance?: number;
  level?: string;
  kind?: string;
  rank?: number;
  rankScore?: number;
}

export interface SweepDetail extends SweepSummary {
  queries: { text: string; weight: number; variant?: string }[];
  windowSince?: string;
  phases: Partial<Record<SweepPhase, SweepPhaseRecord>>;
  completion?: { presented: number[]; skipped: { paperId: number; reason: string }[] };
  papers: SweepPaperView[];
}

export interface PaperMeta {
  id: number;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  server?: string;
  link?: string;
  citations?: number;
  abstract?: string;
}

export interface CardView {
  id: number;
  sweepId: number;
  rank?: number;
  summary: string;
  relevance: number;
  relevanceReason: string;
  trust: number;
  trustReason: string;
  value: number;
  valueReason: string;
  level: string;
  matchedQuestion?: { id: string; text: string };
  borderline: boolean;
  /** An exploration pick: least like the papers you liked (v1.1). */
  exploration: boolean;
  createdAt: string;
  paper: PaperMeta;
  judgment: JudgmentView | null;
}

export type Verdict = "up" | "down" | "star";

export interface JudgmentView {
  verdict: Verdict;
  reason?: string;
  reasonKind?: string;
  ruleStatus: "none" | "candidate" | "unclassified" | "pending";
  updatedAt: string;
}

export interface WeightEffect {
  kind: "question" | "query" | "source";
  key: string;
  before: number;
  after: number;
}

export interface WeightView {
  kind: "question" | "query" | "source";
  key: string;
  base: number;
  value: number;
}

export interface PrecisionPoint {
  sweepId: number;
  startedAt: string;
  top: number;
  judged: number;
  good: number;
  precision: number | null;
}

export interface CardDetail extends CardView {
  weightEffects: WeightEffect[];
  details: {
    decisions: Record<string, { version: number; answers: unknown }>;
    inputs: Record<string, unknown>;
    formulas: Record<string, string>;
  };
}

export interface CardGroup {
  sweep: SweepSummary;
  cards: CardView[];
}

export interface SweepSettings {
  cardsPerSweep: number;
}

// ---------------------------------------------------------------- knowledge base (v0.5)

export interface KbPaper {
  paperId: number;
  cardId: number;
  stem: string | null;
  title: string;
  year?: number;
  venue?: string;
  level?: string;
  reason?: string;
  status: "pending" | "cancelled" | "done" | "failed";
  statusReason?: string;
  addedAt: string;
}

export interface KbNote {
  stem: string;
  path: string;
  properties: Record<string, unknown>;
  body: string;
}

export interface KbSearchHit {
  path: string;
  stem: string;
  title: string;
  excerpt: string;
}
