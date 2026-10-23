// Subagents: children owned by the calling tool task, so research never bloats the parent's context.
// Replay-safe: a rerun after a crash finds the same children (by owner task) and the same submissions (by request id).
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  type AgentChange,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

export interface SubagentSpec {
  prompt: string;
  agent?: AgentChange;
}

export interface SubagentResult {
  index: number;
  conversationId: number;
  status: "done" | "unanswered";
  reason?: string;
  answerText: string;
}

export function answerTextOf(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("")
    .trim();
}

/** Bounded concurrency pool (level09/ask-files.ts). */
export async function runParallel<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Create (or find, on replay) one child per spec in a single commit, then run them with bounded concurrency.
 * Children start as a copy of the caller's agent; `spec.agent` changes it (model, extensions, instructions).
 */
export async function spawnSubagents(
  api: ToolExecutionApi,
  ctx: Context,
  specs: readonly SubagentSpec[],
  options: { requestPrefix: string; concurrency?: number },
): Promise<SubagentResult[]> {
  const ids = await api.commit(async (tx) => {
    const existing = (
      await tx.scanConversations({ ownerTaskId: api.taskId }, specs.length + 10)
    ).items.map((c) => c.id);
    const out: number[] = [];
    for (let i = 0; i < specs.length; i++) {
      if (existing[i] !== undefined) {
        out.push(existing[i] as number);
        continue;
      }
      const child = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      if (specs[i].agent) await configure(tx, child.id, specs[i].agent!);
      out.push(child.id as number);
    }
    return out;
  }, ctx);
  return runParallel(specs, options.concurrency ?? 4, async (spec, index) => {
    const conversationId = ids[index];
    const handle = await api.conversation(conversationId as never, ctx);
    if (!handle) throw new Error(`Subagent conversation ${conversationId} is not available`);
    const submission = await handle.submit(
      { type: "input", content: spec.prompt, requestId: `${options.requestPrefix}:${index}` },
      ctx,
    );
    const settled = await submission.wait(ctx);
    if (settled.status === "done" && settled.type === "input") {
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      return {
        index,
        conversationId,
        status: "done",
        answerText: answerTextOf(entry?.model?.[0] as AssistantMessage | undefined),
      };
    }
    return {
      index,
      conversationId,
      status: "unanswered",
      reason: settled.status === "unanswered" ? settled.reason : settled.status,
      answerText: "",
    };
  });
}
