// Telemetry for one project: the pi-durable commit projector writes here (idempotent upserts by id), and the Runs
// view reads runs, their model calls, tool calls, tokens and cost. Jev calls are recorded alongside.
// A run starts at a user input entry; generations and tool calls in that conversation belong to the latest run.
// Adapted from disler/pi-durable-news-agent's telemetry repo, without its sweep bookkeeping.
import type {
  ConversationTelemetry,
  GenerationTelemetry,
  SubmissionTelemetry,
  TaskTelemetry,
  TelemetryStore,
  ToolResultTelemetry,
  UserInputTelemetry,
} from "@rh/durable-agent";
import type { JevCallRecord } from "@rh/jev";
import { bind, nowIso, type Db } from "./db.ts";

const TEXT_CAP = 20_000;

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

export interface ToolCallRow {
  id: number;
  toolName: string;
  status: string;
  isError: boolean;
  args: unknown;
  result: string | null;
  durationMs: number | null;
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
  toolCallList: ToolCallRow[];
}

export interface CostTotals {
  modelUsd: number;
  jevUsd: number;
  jevUnknownCalls: number;
  totalUsd: number;
  monthUsd: number;
  runs: number;
  jevCalls: number;
}

export class Telemetry implements TelemetryStore {
  constructor(private readonly db: Db) {}

  conversation(rec: ConversationTelemetry): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_conversations (conversation_id, agent, owner_conversation_id, owner_task_id, parent_conversation_id, created_at) VALUES (:id, :agent, :oc, :ot, :pc, :now)",
      )
      .run(
        bind({
          id: rec.conversationId,
          agent: rec.ownerTaskId ? "subagent" : "research-desk",
          oc: rec.ownerConversationId,
          ot: rec.ownerTaskId,
          pc: rec.parentConversationId,
          now: nowIso(),
        }),
      );
  }

  userInput(rec: UserInputTelemetry): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs (run_entry_id, conversation_id, text, started_at) VALUES (:id, :conv, :text, :at)",
      )
      .run(bind({ id: rec.entryId, conv: rec.conversationId, text: rec.text.slice(0, 4000), at: rec.timestamp }));
  }

  private currentRun(conversationId: number): number | undefined {
    const row = this.db
      .prepare("SELECT run_entry_id FROM agent_runs WHERE conversation_id = ? ORDER BY run_entry_id DESC LIMIT 1")
      .get(conversationId) as { run_entry_id: number } | undefined;
    return row?.run_entry_id;
  }

  generation(rec: GenerationTelemetry): void {
    const run = this.currentRun(rec.conversationId);
    const endedAt = rec.durationMs !== undefined ? rec.timestamp + rec.durationMs : undefined;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO generations (entry_id, conversation_id, run_entry_id, task_id, provider, model, stop_reason, error,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, context_tokens,
           duration_ms, text, tool_calls, started_at, ended_at)
         VALUES (:entry, :conv, :run, :task, :provider, :model, :stop, :error, :input, :output, :cr, :cw, :total, :cost,
           :ctx, :dur, :text, :calls, :started, :ended)`,
      )
      .run(
        bind({
          entry: rec.entryId,
          conv: rec.conversationId,
          run,
          task: rec.taskId,
          provider: rec.provider,
          model: rec.model,
          stop: rec.stopReason,
          error: rec.errorMessage,
          input: rec.usage.input,
          output: rec.usage.output,
          cr: rec.usage.cacheRead,
          cw: rec.usage.cacheWrite,
          total: rec.usage.totalTokens,
          cost: rec.usage.cost,
          ctx: rec.contextTokens,
          dur: rec.durationMs,
          text: rec.text.slice(0, TEXT_CAP),
          calls: rec.toolCalls.length,
          started: rec.timestamp,
          ended: endedAt,
        }),
      );
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tool_calls (generation_entry_id, call_id, conversation_id, run_entry_id, tool_name, args_json) VALUES (:gen, :call, :conv, :run, :name, :args)",
    );
    for (const c of rec.toolCalls)
      insert.run(bind({ gen: rec.entryId, call: c.id, conv: rec.conversationId, run, name: c.name, args: c.arguments ?? {} }));
    if (run === undefined) return;
    // An aborted generation (process killed or turn interrupted) is not an answer: the run stays open until the
    // resumed turn produces one.
    const status =
      rec.stopReason === "error"
        ? "error"
        : rec.stopReason === "aborted" || rec.toolCalls.length
          ? "running"
          : "done";
    this.db
      .prepare(
        "UPDATE agent_runs SET ended_at = :ended, status = CASE WHEN status = 'done' THEN status ELSE :status END, answer_entry_id = CASE WHEN :done = 1 THEN :entry ELSE answer_entry_id END WHERE run_entry_id = :run",
      )
      .run(bind({ ended: endedAt ?? rec.timestamp, status, done: status === "done", entry: rec.entryId, run }));
  }

  task(rec: TaskTelemetry): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, conversation_id, kind, owner_task_id, background, status, outcome, error, started_at, ended_at)
         VALUES (:id, :conv, :kind, :owner, :bg, :status, :outcome, :error, :started, :ended)
         ON CONFLICT (task_id) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, error = excluded.error,
           started_at = COALESCE(excluded.started_at, tasks.started_at), ended_at = COALESCE(excluded.ended_at, tasks.ended_at)`,
      )
      .run(
        bind({
          id: rec.taskId,
          conv: rec.conversationId,
          kind: rec.kind,
          owner: rec.ownerTaskId,
          bg: rec.background,
          status: rec.status,
          outcome: rec.outcome,
          error: rec.error,
          started: rec.startedAt,
          ended: rec.endedAt,
        }),
      );
    if (rec.kind !== "pi.tool") return;
    const input = rec.input as { assistant?: number; callId?: string };
    if (input?.assistant === undefined || !input.callId) return;
    const status =
      rec.status === "terminal" ? (rec.outcome === "completed" ? "done" : (rec.outcome ?? "done")) : rec.status;
    this.db
      .prepare(
        `UPDATE tool_calls SET task_id = :task, started_at = COALESCE(:started, started_at), ended_at = COALESCE(:ended, ended_at),
           status = CASE WHEN status IN ('done', 'error') THEN status ELSE :status END
         WHERE generation_entry_id = :gen AND call_id = :call`,
      )
      .run(bind({ task: rec.taskId, started: rec.startedAt, ended: rec.endedAt, status, gen: input.assistant, call: input.callId }));
  }

  toolResult(rec: ToolResultTelemetry): void {
    const params = bind({
      is_error: rec.isError,
      text: rec.text.slice(0, TEXT_CAP),
      entry: rec.entryId,
      dur: rec.durationMs,
      status: rec.isError ? "error" : "done",
      task: rec.taskId,
      conv: rec.conversationId,
      call: rec.callId,
    });
    const set =
      "is_error = :is_error, result_text = :text, result_entry_id = :entry, duration_ms = :dur, status = :status";
    const byTask =
      rec.taskId !== undefined
        ? this.db.prepare(`UPDATE tool_calls SET ${set} WHERE task_id = :task`).run(params)
        : undefined;
    if (!byTask || Number(byTask.changes) === 0)
      this.db
        .prepare(
          `UPDATE tool_calls SET ${set} WHERE id = (SELECT id FROM tool_calls WHERE conversation_id = :conv AND call_id = :call ORDER BY id DESC LIMIT 1)`,
        )
        .run(params);
  }

  submission(rec: SubmissionTelemetry): void {
    if (rec.type !== "input" || rec.entryId === undefined) return;
    this.db
      .prepare(
        "UPDATE agent_runs SET request_id = COALESCE(:req, request_id), submission_id = :sub, status = CASE WHEN :status = 'unanswered' THEN 'unanswered' ELSE status END WHERE run_entry_id = :entry",
      )
      .run(bind({ req: rec.requestId, sub: rec.submissionId, status: rec.status, entry: rec.entryId }));
  }

  // Jev

  jevCall(rec: JevCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO jev_calls (command, version, provider, model, questions, answers_json, input_tokens, output_tokens,
           cost_usd, cost_source, elapsed_ms, attempts, error, created_at)
         VALUES (:command, :version, :provider, :model, :questions, :answers, :input, :output, :cost, :source, :elapsed,
           :attempts, :error, :now)`,
      )
      .run(
        bind({
          command: rec.command,
          version: rec.version,
          provider: rec.provider,
          model: rec.model,
          questions: rec.questions,
          answers: rec.answers,
          input: rec.inputTokens,
          output: rec.outputTokens,
          cost: rec.cost.amount,
          source: rec.cost.source,
          elapsed: rec.elapsedMs,
          attempts: rec.attempts,
          error: rec.error,
          now: nowIso(),
        }),
      );
  }

  // Reads

  private summarize(row: any): RunSummary {
    const agg = this.db
      .prepare(
        "SELECT COUNT(*) gens, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) tin, COALESCE(SUM(output_tokens), 0) tout, COALESCE(SUM(cost_usd), 0) cost, GROUP_CONCAT(DISTINCT model) models FROM generations WHERE run_entry_id = ?",
      )
      .get(row.run_entry_id) as any;
    const calls = this.db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE run_entry_id = ?").get(row.run_entry_id) as any;
    return {
      id: row.run_entry_id,
      conversationId: row.conversation_id,
      text: row.text ?? "",
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? null,
      models: agg.models ? String(agg.models).split(",") : [],
      generations: agg.gens,
      toolCalls: calls.n,
      inputTokens: agg.tin,
      outputTokens: agg.tout,
      costUsd: agg.cost,
    };
  }

  runs(options: { limit?: number; before?: number; conversationId?: number } = {}): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE (:conv IS NULL OR conversation_id = :conv) AND (:before IS NULL OR run_entry_id < :before)
         ORDER BY run_entry_id DESC LIMIT :limit`,
      )
      .all(bind({ conv: options.conversationId, before: options.before, limit: options.limit ?? 50 }));
    return rows.map((r) => this.summarize(r));
  }

  run(id: number): RunDetail | undefined {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE run_entry_id = ?").get(id);
    if (!row) return undefined;
    const generationList = (
      this.db.prepare("SELECT * FROM generations WHERE run_entry_id = ? ORDER BY entry_id").all(id) as any[]
    ).map((g) => ({
      entryId: g.entry_id,
      model: g.model,
      stopReason: g.stop_reason,
      inputTokens: g.input_tokens + g.cache_read_tokens + g.cache_write_tokens,
      outputTokens: g.output_tokens,
      costUsd: g.cost_usd,
      durationMs: g.duration_ms,
      text: g.text,
    }));
    const toolCallList = (
      this.db.prepare("SELECT * FROM tool_calls WHERE run_entry_id = ? ORDER BY id").all(id) as any[]
    ).map((c) => ({
      id: c.id,
      toolName: c.tool_name,
      status: c.status,
      isError: !!c.is_error,
      args: c.args_json ? JSON.parse(c.args_json) : null,
      result: c.result_text,
      durationMs: c.duration_ms,
    }));
    return { ...this.summarize(row), generationList, toolCallList };
  }

  totals(now = new Date()): CostTotals {
    const month = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    const model = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) c FROM generations").get() as any;
    const modelMonth = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) c FROM generations WHERE started_at >= ?")
      .get(Date.parse(month)) as any;
    const jev = this.db
      .prepare(
        "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) c, COALESCE(SUM(CASE WHEN cost_source = 'unknown' THEN 1 END), 0) unknown FROM jev_calls",
      )
      .get() as any;
    const jevMonth = this.db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) c FROM jev_calls WHERE created_at >= ?",
      )
      .get(month) as any;
    const runs = this.db.prepare("SELECT COUNT(*) n FROM agent_runs").get() as any;
    return {
      modelUsd: model.c,
      jevUsd: jev.c,
      jevUnknownCalls: jev.unknown,
      totalUsd: model.c + jev.c,
      monthUsd: modelMonth.c + jevMonth.c,
      runs: runs.n,
      jevCalls: jev.n,
    };
  }

  contextTokens(conversationId: number): number {
    const row = this.db
      .prepare("SELECT context_tokens FROM generations WHERE conversation_id = ? ORDER BY entry_id DESC LIMIT 1")
      .get(conversationId) as { context_tokens: number } | undefined;
    return row?.context_tokens ?? 0;
  }
}
