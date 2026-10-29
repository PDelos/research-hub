// Normalize pi-durable entries plus live generation state into renderable transcript items. The browser, the TUI
// and GET /v1/agent/transcript all use this, so every client stitches tool calls and results the same way.
import type {
  WireAssistantMessage,
  WireEntry,
  WireMessage,
  WireToolResultMessage,
  WireToolSlot,
  WireUsage,
  WireUsageState,
} from "./wire.ts";

export type ToolStatus = "pending" | "running" | "done" | "error";

export interface ToolCallView {
  callId: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  /** Live output while running. */
  output?: string;
  /** Result text once the result entry exists. */
  result?: string;
  resultEntryId?: number;
}

export type AssistantBlockView =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; call: ToolCallView };

export type TranscriptItem =
  | { kind: "user"; id: number; text: string }
  | {
      kind: "assistant";
      id: number | "live";
      streaming: boolean;
      blocks: AssistantBlockView[];
      error?: string;
      model?: string;
    }
  | { kind: "tool-result"; id: number; name: string; text: string; isError: boolean }
  | { kind: "tool"; id: string; call: ToolCallView }
  | { kind: "event"; id: number; entryKind: string; text: string; note?: string; data?: unknown };

export interface LiveTool {
  name: string;
  status: "pending" | "running" | "done";
  output: string;
  args?: unknown;
}

const isAssistant = (m: WireMessage): m is WireAssistantMessage => m.role === "assistant";
const isToolResult = (m: WireMessage): m is WireToolResultMessage => m.role === "toolResult";

export function messageText(message: WireMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

export function assistantError(message: WireAssistantMessage): string | undefined {
  if (message.errorMessage) return message.errorMessage;
  if (message.stopReason === "aborted") return "Interrupted. Partial response preserved.";
  if (message.stopReason === "error") return "Provider request failed.";
  return undefined;
}

function eventText(entry: WireEntry): string {
  const data = entry.data as { text?: unknown } | undefined;
  if (typeof data?.text === "string") return data.text;
  if (entry.kind === "pi.reset") return "New context started. Earlier entries remain stored.";
  if (entry.kind === "pi.compaction") return "Context compacted. Earlier entries remain stored.";
  return entry.kind;
}

interface ToolCalls {
  /** Tool results by call id, with the entry that holds them. */
  results: Map<string, { entryId: number; message: WireToolResultMessage }>;
  /** Every call id an assistant message made (stored or live). */
  callIds: Set<string>;
}

function collectToolCalls(entries: readonly WireEntry[], live?: WireAssistantMessage): ToolCalls {
  const calls: ToolCalls = { results: new Map(), callIds: new Set() };
  const addCalls = (message: WireAssistantMessage) => {
    for (const block of message.content) if (block.type === "toolCall") calls.callIds.add(block.id);
  };
  for (const entry of entries)
    for (const message of entry.model ?? []) {
      if (entry.kind === "pi.tool-result" && isToolResult(message))
        calls.results.set(message.toolCallId, { entryId: entry.id, message });
      if (entry.kind === "pi.assistant" && isAssistant(message)) addCalls(message);
    }
  if (live) addCalls(live);
  return calls;
}

function toolView(
  calls: ToolCalls,
  tools: ReadonlyMap<string, LiveTool>,
  call: { id: string; name: string; args: unknown },
): ToolCallView {
  const result = calls.results.get(call.id);
  if (result)
    return {
      callId: call.id,
      name: call.name,
      args: call.args,
      status: result.message.isError ? "error" : "done",
      result: messageText(result.message),
      resultEntryId: result.entryId,
    };
  const running = tools.get(call.id);
  return {
    callId: call.id,
    name: call.name,
    args: call.args,
    status: running?.status === "running" ? "running" : "pending",
    output: running?.output || undefined,
  };
}

function entryItems(
  entry: WireEntry,
  calls: ToolCalls,
  blocks: (message: WireAssistantMessage) => AssistantBlockView[],
): TranscriptItem[] {
  const messages = entry.model ?? [];
  if (entry.kind === "pi.system") return [];
  if (entry.kind === "pi.user") return [{ kind: "user", id: entry.id, text: messages.map(messageText).join("\n") }];
  if (entry.kind === "pi.assistant") {
    const assistant = messages.filter(isAssistant);
    return [
      {
        kind: "assistant",
        id: entry.id,
        streaming: false,
        blocks: assistant.flatMap(blocks),
        error: assistant.map(assistantError).find(Boolean),
        model: assistant[0]?.model,
      },
    ];
  }
  // Results whose call is shown inline with its assistant message are not listed again.
  if (entry.kind === "pi.tool-result")
    return messages
      .filter(isToolResult)
      .filter((message) => !calls.callIds.has(message.toolCallId))
      .map((message) => ({
        kind: "tool-result",
        id: entry.id,
        name: message.toolName,
        text: messageText(message),
        isError: message.isError,
      }));
  return [
    {
      kind: "event",
      id: entry.id,
      entryKind: entry.kind,
      text: eventText(entry),
      note: messages.length ? messages.map(messageText).join("\n") : undefined,
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    },
  ];
}

export function toTranscript(
  entries: readonly WireEntry[],
  live?: WireAssistantMessage,
  tools: ReadonlyMap<string, LiveTool> = new Map(),
): TranscriptItem[] {
  const calls = collectToolCalls(entries, live);
  const blocks = (message: WireAssistantMessage): AssistantBlockView[] =>
    message.content.flatMap((block): AssistantBlockView[] => {
      if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
      if (block.type === "thinking") return block.thinking ? [{ type: "thinking", text: block.thinking }] : [];
      return [
        { type: "tool", call: toolView(calls, tools, { id: block.id, name: block.name, args: block.arguments }) },
      ];
    });

  const items = entries.flatMap((entry) => entryItems(entry, calls, blocks));
  if (live) items.push({ kind: "assistant", id: "live", streaming: true, blocks: blocks(live), model: live.model });
  // Tools still running whose call has not reached the transcript yet.
  for (const [callId, tool] of tools)
    if (tool.status !== "done" && !calls.callIds.has(callId))
      items.push({
        kind: "tool",
        id: callId,
        call: toolView(calls, tools, { id: callId, name: tool.name, args: tool.args }),
      });
  return items;
}

const fenced = (text: string) => `\`\`\`\n${text.slice(0, 2000)}\n\`\`\``;

function blockMarkdown(block: AssistantBlockView): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return `> _thinking:_ ${block.text.replaceAll("\n", " ").slice(0, 400)}`;
  const result = block.call.result ? `\n\n${fenced(block.call.result)}` : "";
  return `- \`${block.call.name}\` ${block.call.status}${result}`;
}

function itemMarkdown(item: TranscriptItem): string {
  if (item.kind === "user") return `### You (#${item.id})\n\n${item.text}`;
  if (item.kind === "assistant") {
    const parts = item.blocks.map(blockMarkdown);
    if (item.error) parts.push(`> ${item.error}`);
    return `### Agent (${item.id === "live" ? "working" : `#${item.id}`})\n\n${parts.join("\n\n")}`;
  }
  if (item.kind === "tool-result")
    return `- \`${item.name}\` ${item.isError ? "error" : "result"}\n\n${fenced(item.text)}`;
  if (item.kind === "tool") return `- \`${item.call.name}\` ${item.call.status}`;
  return `_${item.text}_`;
}

export function toMarkdown(items: readonly TranscriptItem[]): string {
  return items.map(itemMarkdown).join("\n\n") + "\n";
}

/** Text of the last assistant entry, for previews and simple clients. */
export function lastAssistantText(entries: readonly WireEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "pi.assistant") continue;
    const text = (entry.model ?? []).filter(isAssistant).map(messageText).join("").trim();
    if (text) return text;
  }
  return undefined;
}

export interface UsageSummary {
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export function sumUsage(state?: Pick<WireUsageState, "models"> | { models: Record<string, WireUsage> }): UsageSummary {
  const total: UsageSummary = {
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
  for (const usage of Object.values(state?.models ?? {})) {
    total.tokens += usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    total.cost += usage.cost?.total ?? 0;
    for (const field of USAGE_FIELDS) {
      total[field] += usage[field] ?? 0;
      total[`${field}Cost`] += usage.cost?.[field] ?? 0;
    }
  }
  return total;
}

export type { WireToolSlot };
