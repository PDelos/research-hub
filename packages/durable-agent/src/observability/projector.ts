// The commit projector: every committed conversation, entry and task becomes a telemetry row.
// pi-durable 1.1.0 publications carry the full records, so durationMs, startedAt and endedAt need no extra reads.
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { CommitChange, EntryRecord, Harness, TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { answerTextOf } from "../subagents.ts";
import { type LoggerLike, silentLogger, type TelemetryStore, type UsageNumbers } from "./types.ts";

export function usageNumbers(usage: Usage | undefined): UsageNumbers {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: usage?.cost?.total ?? 0,
  };
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("")
      : "";

export function projectEntry(entry: EntryRecord, store: TelemetryStore): void {
  const message = entry.model?.[0];
  const base = {
    entryId: entry.id as number,
    conversationId: entry.conversationId as number,
    taskId: entry.byTaskId as number | undefined,
  };
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const m = message as AssistantMessage;
    const usage = usageNumbers(m.usage);
    store.generation({
      ...base,
      provider: m.provider,
      model: m.model,
      stopReason: m.stopReason,
      errorMessage: m.errorMessage,
      usage,
      contextTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      durationMs: m.durationMs,
      thinkingChars: m.content
        .filter((b) => b.type === "thinking")
        .reduce((n, b) => n + ((b as { thinking: string }).thinking?.length ?? 0), 0),
      text: answerTextOf(m),
      toolCalls: m.content
        .filter((b) => b.type === "toolCall")
        .map((b) => {
          const call = b as { id: string; name: string; arguments: unknown };
          return { id: call.id, name: call.name, arguments: call.arguments };
        }),
      timestamp: m.timestamp,
    });
    return;
  }
  if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
    const m = message as ToolResultMessage;
    store.toolResult({
      ...base,
      callId: m.toolCallId,
      toolName: m.toolName,
      isError: m.isError,
      durationMs: m.durationMs,
      text: textOf(m.content),
      details: m.details,
      usage: m.usage ? usageNumbers(m.usage) : undefined,
      timestamp: m.timestamp,
    });
    return;
  }
  if (entry.kind === "pi.user" && message?.role === "user") {
    store.userInput({
      entryId: base.entryId,
      conversationId: base.conversationId,
      text: textOf(message.content),
      timestamp: message.timestamp,
    });
    return;
  }
  store.entry?.({ ...base, kind: entry.kind, data: entry.data });
}

export function projectTask(
  task: TaskRecord<JsonValue, JsonValue, JsonValue>,
  store: TelemetryStore,
): void {
  const state = task.state as {
    status: string;
    outcome?: { status: string; error?: { message?: string } };
  };
  store.task({
    taskId: task.id as number,
    conversationId: task.conversationId as number,
    kind: task.kind,
    ownerTaskId: task.owner as number | undefined,
    background: task.background,
    status: state.status,
    outcome: state.outcome?.status,
    error: state.outcome?.error?.message,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    input: task.input,
  });
}

export function projectChange(change: CommitChange, store: TelemetryStore): void {
  if (change.type === "submission") {
    const r = change.value as {
      id: number;
      conversationId: number;
      requestId?: string;
      type: string;
      status: string;
      entry?: number;
      answer?: number;
      reason?: string;
    };
    store.submission?.({
      submissionId: r.id,
      conversationId: r.conversationId,
      requestId: r.requestId,
      type: r.type,
      status: r.status,
      entryId: r.entry,
      answerEntryId: r.answer,
      reason: r.reason,
    });
    return;
  }
  if (change.type === "conversation") {
    const c = change.value;
    store.conversation({
      conversationId: c.id as number,
      ownerConversationId: c.owner?.conversationId as number | undefined,
      ownerTaskId: c.owner?.taskId as number | undefined,
      parentConversationId: c.parent?.conversationId as number | undefined,
    });
  } else if (change.type === "entry") projectEntry(change.value, store);
  else if (change.type === "task") projectTask(change.value, store);
}

/**
 * Order inside one commit is unspecified, so sort it: conversations, then user and assistant entries (runs and the
 * tool calls they declare), then tasks (tool timings), then tool results and other entries, then submissions.
 */
export function rank(change: CommitChange): number {
  if (change.type === "conversation") return 0;
  if (change.type === "entry")
    return change.value.kind === "pi.user" || change.value.kind === "pi.assistant" ? 1 : 3;
  if (change.type === "task") return 2;
  if (change.type === "submission") return 4;
  return 5;
}

/** Subscribe and project off the Session line. Returns a stop function. */
export function startProjector(
  harness: Harness,
  store: TelemetryStore,
  log: LoggerLike = silentLogger,
): () => void {
  const queue: CommitChange[] = [];
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    while (queue.length) {
      const change = queue.shift()!;
      try {
        projectChange(change, store);
      } catch (error) {
        log.error("telemetry.project_failed", { error, change: change.type });
      }
    }
  };
  const unsubscribe = harness.subscribeCommits((publication) => {
    const relevant = publication.changes.filter(
      (c) =>
        c.type === "conversation" ||
        c.type === "entry" ||
        c.type === "task" ||
        c.type === "submission",
    );
    queue.push(...relevant.sort((a, b) => rank(a) - rank(b)));
    if (!scheduled && queue.length) {
      scheduled = true;
      setImmediate(drain);
    }
  });
  return () => {
    unsubscribe();
    drain();
  };
}
