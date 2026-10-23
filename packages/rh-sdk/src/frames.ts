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
  | { type: "usage"; totals: CostTotals };

// ---------------------------------------------------------------- project, charter, schedule (v0.1)

export type ProjectStatus = "needs-brief" | "charter-review" | "active" | "paused";

export interface ProjectOverview {
  name: string;
  status: ProjectStatus;
  charterVersion: number | null;
  hasDraft: boolean;
  charterRun: "running" | "done" | "failed" | null;
  paused: { since: string } | null;
  next: { sweep: string | null; review: string | null; timeZone: string };
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
  review: { enabled: boolean; weekday: Weekday; time: string };
}

export interface ScheduledRun {
  id: number;
  kind: "sweep" | "review";
  slot: string;
  slotAt: number | null;
  trigger: "scheduled" | "manual";
  status: "requested" | "running" | "done" | "failed" | "skipped";
  reason: string | null;
  createdAt: string;
}
