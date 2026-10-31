// The server-sent event frames of GET /v1/p/:slug/stream and the API shapes clients read.
// hello → agent.snapshot → agent.batch… plus agent.state and usage whenever they change.
import type { WireAgentEvent, WireSnapshotEvent } from "./wire.ts";
import type { PluginRunState, PluginSummary } from "./plugin-views.ts";
import type { SweepSummary } from "./project-views.ts";

export * from "./plugin-views.ts";
export * from "./project-views.ts";
export * from "./cycle-views.ts";

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
  /** RH_PROFILE (v2.0): core leaves the advanced features off and shows four tabs; full is everything. */
  profile: "core" | "full";
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
