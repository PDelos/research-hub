// The observability extension: pi-durable hooks report what the agent did, request by request and call by call.
// Hooks never throw and never change behavior; they only report. Select it in every conversation.
import {
  CompactionTask,
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type Extension,
} from "@earendil-works/pi-durable";
import type { AgentHookEvent, ObservabilitySink } from "./types.ts";

const preview = (value: unknown, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > max
    ? `${text.slice(0, max)} [${text.length - max} more chars]`
    : text;
};

const charsOf = (value: unknown): number => {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + charsOf(v), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce((n: number, v) => n + charsOf(v), 0);
  return 0;
};

export function observability(sink: ObservabilitySink, name = "observability"): Extension {
  const emit = (e: AgentHookEvent) => {
    try {
      sink.event(e);
    } catch {
      // Observability must never break the agent.
    }
  };
  return defineExtension({
    name,
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request, api) => {
          emit({
            event: "generation.request",
            level: "debug",
            conversationId: api.conversationId as number,
            taskId: api.taskId as number,
            data: {
              messages: request.messages.length,
              estimatedTokens: Math.round(charsOf(request.messages) / 4),
            },
          });
          return undefined;
        },
        afterResponse: (message, api) => {
          const toolCalls = message.content
            .filter((b) => b.type === "toolCall")
            .map((b) => (b as { name: string }).name);
          emit({
            event: "generation.response",
            level: message.stopReason === "error" ? "error" : "info",
            conversationId: api.conversationId as number,
            taskId: api.taskId as number,
            data: {
              provider: message.provider,
              model: message.model,
              stopReason: message.stopReason,
              errorMessage: message.errorMessage,
              durationMs: message.durationMs,
              input: message.usage.input,
              output: message.usage.output,
              cacheRead: message.usage.cacheRead,
              cost: message.usage.cost.total,
              toolCalls,
            },
          });
        },
        afterTools: (assistant, results, api) => {
          emit({
            event: "generation.tools_done",
            level: "debug",
            conversationId: api.conversationId as number,
            taskId: api.taskId as number,
            data: { assistantEntry: assistant, results: results.length },
          });
        },
      }),
      hook(ToolTask, {
        beforeTool: (call, api) => {
          emit({
            event: "tool.start",
            level: "info",
            conversationId: api.conversationId as number,
            taskId: api.taskId as number,
            data: { callId: call.id, tool: call.name, args: preview(call.arguments) },
          });
          return undefined;
        },
        afterTool: (call, result, api) => {
          emit({
            event: result.isError ? "tool.error" : "tool.end",
            level: result.isError ? "warn" : "info",
            conversationId: api.conversationId as number,
            taskId: api.taskId as number,
            data: {
              callId: call.id,
              tool: call.name,
              isError: result.isError ?? false,
              diagnostics: result.diagnostics,
              result: preview(
                result.content?.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(""),
              ),
            },
          });
          return undefined;
        },
      }),
      hook(CompactionTask, {
        beforeCompact: (compaction, api) => {
          emit({
            event: "compaction.start",
            level: "info",
            conversationId: api.conversationId as number,
            taskId: api.taskId as number,
            data: {
              reason: compaction.reason,
              entries: compaction.entries.length,
              firstKept: compaction.firstKept,
            },
          });
          return undefined;
        },
      }),
    ],
  });
}
