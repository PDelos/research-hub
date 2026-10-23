// Tool helpers: tools that teach the model when a call fails, exactly-once effects, allow-lists.
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineTool,
  hook,
  ToolTask,
  type HookRegistration,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";

export interface AppToolSpec<P extends TSchema, D extends JsonValue = JsonValue> extends Omit<
  ToolRegistration<P, D>,
  "prepareArguments"
> {
  /**
   * Top-level string fields that must hold one of these values. Checked before schema validation, so a wrong value
   * comes back as an invalid_arguments result that lists every valid value and an example call.
   */
  enums?: Record<string, readonly string[]>;
  example?: Record<string, unknown>;
  /** What a call returns, for people reading the tool list (the model sees the result itself). */
  returns?: string;
}

/** What a reader needs to know about a tool beyond its registration: its return and an example call. */
export interface ToolDoc {
  returns?: string;
  example?: Record<string, unknown>;
  enums?: Record<string, readonly string[]>;
}
const DOCS = new Map<string, ToolDoc>();

/** The doc defineAppTool recorded for a tool name. */
export const toolDoc = (name: string): ToolDoc | undefined => DOCS.get(name);

export function enumFeedback(
  tool: string,
  args: unknown,
  enums: Record<string, readonly string[]>,
  example?: Record<string, unknown>,
): void {
  if (!args || typeof args !== "object") return;
  for (const [field, allowed] of Object.entries(enums)) {
    const value = (args as Record<string, unknown>)[field];
    if (value === undefined || (typeof value === "string" && allowed.includes(value))) continue;
    const hint = example ? ` Example call: ${JSON.stringify(example)}` : "";
    throw new Error(
      `${tool}: "${field}" must be one of: ${allowed.join(", ")}. You sent ${JSON.stringify(value)}.${hint}`,
    );
  }
}

export function defineAppTool<P extends TSchema, D extends JsonValue = JsonValue>(
  spec: AppToolSpec<P, D>,
): ToolRegistration<P, D> {
  const { enums, example, returns, ...tool } = spec;
  DOCS.set(tool.name, { returns, example, enums });
  return defineTool<P, D>({
    ...tool,
    ...(enums
      ? {
          prepareArguments: (args: unknown) => {
            enumFeedback(tool.name, args, enums, example);
            return args as Static<P>;
          },
        }
      : {}),
  });
}

export function toolText<D extends JsonValue = JsonValue>(
  text: string,
  details?: D,
): ToolExecutionResult<D> {
  return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
}

/** A failed call the model can fix: returned, not thrown, so work the call owns survives. */
export function toolError(message: string, hints: string[] = []): ToolExecutionResult {
  const text = [message, ...hints.map((h) => `Fix: ${h}`)].join("\n");
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Exactly-once for a call's effect across crash and replay: the result is kept in the call's durable task memo.
 * A crash between the effect and the memo repeats the effect, so effects must also be idempotent (a unique key).
 */
export async function once<T extends JsonValue>(
  api: ToolExecutionApi,
  key: string,
  ctx: Context,
  fn: () => Promise<T>,
): Promise<T> {
  const done = await api.memo<T>(key, ctx);
  if (done !== undefined) return done;
  return api.memo<T>(key, await fn(), ctx);
}

/** Block any tool outside `names` in conversations that select this hook's extension. */
export function allowOnly(agent: string, names: readonly string[]): HookRegistration {
  return hook(ToolTask, {
    beforeTool: (call) =>
      names.includes(call.name)
        ? undefined
        : { block: `Tool ${call.name} is not allowed for ${agent}` },
  });
}

/** Task-scoped receipt: the effect and its record commit together (pattern from run_durable_job). */
export const TaskReceipt = defineDoc<{ value: JsonValue }>({
  kind: "durable-agent.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ value: null }),
});

/**
 * Run `fn` inside one commit at most once per tool task, for effects that are themselves commits (creating a task or
 * a child conversation). A replay after a crash returns the stored value instead of creating a second one.
 */
export async function onceInCommit<T extends JsonValue>(
  api: ToolExecutionApi,
  ctx: Context,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return api.commit(async (tx) => {
    const receipt = await tx.doc(TaskReceipt, api.taskId);
    if (receipt.value !== null) return receipt.value as T;
    const value = await fn(tx);
    receipt.value = value;
    return value;
  }, ctx);
}
