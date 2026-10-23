// Sinks the host implements. The foundation never imports the app: it reports through these.

export interface LoggerLike {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

/** One agent behavior event from a pi-durable hook. */
export interface AgentHookEvent {
  event: string;
  level: "debug" | "info" | "warn" | "error";
  conversationId: number;
  taskId: number;
  data: Record<string, unknown>;
}

export interface ObservabilitySink {
  event(e: AgentHookEvent): void;
}

export interface UsageNumbers {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface ConversationTelemetry {
  conversationId: number;
  ownerConversationId?: number;
  ownerTaskId?: number;
  parentConversationId?: number;
}

export interface GenerationTelemetry {
  entryId: number;
  conversationId: number;
  taskId?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage: UsageNumbers;
  /** input + cacheRead + cacheWrite: the context the model read for this response. */
  contextTokens: number;
  durationMs?: number;
  thinkingChars: number;
  text: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  timestamp: number;
}

export interface ToolResultTelemetry {
  entryId: number;
  conversationId: number;
  taskId?: number;
  callId: string;
  toolName: string;
  isError: boolean;
  durationMs?: number;
  text: string;
  details?: unknown;
  usage?: UsageNumbers;
  timestamp: number;
}

export interface UserInputTelemetry {
  entryId: number;
  conversationId: number;
  text: string;
  timestamp: number;
}

export interface TaskTelemetry {
  taskId: number;
  conversationId: number;
  kind: string;
  ownerTaskId?: number;
  background: boolean;
  status: string;
  outcome?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  input: unknown;
}

export interface OtherEntryTelemetry {
  entryId: number;
  conversationId: number;
  kind: string;
  data: unknown;
  taskId?: number;
}

export interface SubmissionTelemetry {
  submissionId: number;
  conversationId: number;
  requestId?: string;
  type: string;
  status: string;
  entryId?: number;
  answerEntryId?: number;
  reason?: string;
}

/** Where the commit projector writes. Implementations must be idempotent (upsert by ids). */
export interface TelemetryStore {
  conversation(rec: ConversationTelemetry): void;
  generation(rec: GenerationTelemetry): void;
  toolResult(rec: ToolResultTelemetry): void;
  userInput(rec: UserInputTelemetry): void;
  task(rec: TaskTelemetry): void;
  entry?(rec: OtherEntryTelemetry): void;
  submission?(rec: SubmissionTelemetry): void;
}
