// pi-ai and pi-durable JSON shapes as they cross the wire (watchEvents frames, entries, usage).
export interface WireText {
  type: "text";
  text: string;
}
export interface WireThinking {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
export interface WireToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
export interface WireImage {
  type: "image";
  data: string;
  mimeType: string;
}
export type WireAssistantBlock = WireText | WireThinking | WireToolCall;

export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface WireUserMessage {
  role: "user";
  content: string | readonly (WireText | WireImage)[];
  timestamp?: number;
}
export interface WireAssistantMessage {
  role: "assistant";
  content: readonly WireAssistantBlock[];
  provider: string;
  model: string;
  usage: WireUsage;
  stopReason: string;
  errorMessage?: string;
  timestamp?: number;
}
export interface WireToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: readonly (WireText | WireImage)[];
  isError: boolean;
  details?: unknown;
  timestamp?: number;
}
export interface WireOtherMessage {
  role: string;
}
export type WireMessage =
  | WireUserMessage
  | WireAssistantMessage
  | WireToolResultMessage
  | WireOtherMessage;

export interface WireEntry {
  id: number;
  conversationId: number;
  kind: string;
  model?: readonly WireMessage[];
  data?: unknown;
  head?: number;
  byTaskId?: number;
}

export interface WireToolSlot {
  callId: string;
  name: string;
  taskId?: number;
  status: "pending" | "running" | "done";
  output?: string;
  droppedBytes?: number;
  droppedLines?: number;
  details?: unknown;
  entry?: number;
}

export interface WireCompaction {
  taskId: number;
  reason: string;
  blocking: boolean;
  attempt: number;
  retry?: { at: number; error: string };
}

export interface WireAgentState {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  extensions?: unknown;
  tools?: unknown;
  instructions?: string;
  cwd?: string;
}

export interface WireUsageState {
  models: Readonly<Record<string, WireUsage>>;
  tools: Readonly<Record<string, WireUsage>>;
}

export interface WireQueued {
  id: number;
  mode: string;
}

export type WireMessageChange =
  | {
      type: "text_start" | "thinking_start" | "toolcall_start";
      contentIndex: number;
      block: WireAssistantBlock;
    }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      path: readonly (string | number)[];
      delta: string;
    }
  | { type: "block"; contentIndex: number; block: WireAssistantBlock }
  | { type: "message"; message: WireAssistantMessage };

export interface WireSnapshotEvent {
  type: "snapshot";
  entries: readonly WireEntry[];
  run?: { inputs: readonly number[] };
  generation?: {
    attempt: number;
    message?: WireAssistantMessage;
    retry?: { at: number; error: string };
    deferred?: { pollAt: number };
  };
  tools: readonly WireToolSlot[];
  compactions: readonly WireCompaction[];
  inbox: readonly WireQueued[];
  agent: WireAgentState;
  usage: WireUsageState;
}

export type WireAgentEvent =
  | WireSnapshotEvent
  | { type: "run_start" | "run_end"; inputs: readonly number[] }
  | { type: "turn_start" | "turn_end" }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_update"; usage: WireUsage; changes: readonly WireMessageChange[] }
  | { type: "message_end"; entry: WireEntry }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      output?: { trimStart?: number; append?: string } | { set: string };
      details?: unknown;
      diagnostics?: readonly unknown[];
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: WireEntry }
  | { type: "inbox_update"; items: readonly WireQueued[] }
  | { type: "submission"; record: { id: number; status: string } }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "entry_appended"; entry: WireEntry }
  | { type: "agent_changed"; agent: WireAgentState }
  | { type: "usage_changed"; usage: WireUsageState }
  | { type: "task_failed"; taskId: number; kind: string; message: string }
  | { type: "compaction_start"; taskId: number; reason: string; blocking: boolean }
  | { type: "compaction_end"; taskId: number; reason: string };

/** A queued submission with its content, read from the conversation's `pi.inbox` document. */
export interface InboxItem {
  id: number;
  mode: "steer" | "followUp" | "write";
  content?: string;
}
