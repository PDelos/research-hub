/** Totals for every jev call, plus a sink so the host can persist each one (jev_calls). */
import type { JevCost, JevProvider, SystemOneResult } from "./client.ts";
import type { Answer } from "./types.ts";

export interface JevCallRecord {
  command?: string;
  version?: number;
  provider?: JevProvider;
  model?: string;
  answers?: Record<string, Answer>;
  inputTokens?: number;
  outputTokens?: number;
  cost: JevCost;
  elapsedMs?: number;
  attempts?: number;
  questions: number;
  error?: string;
  extra?: Record<string, unknown>;
}

export class JevLedger {
  calls = 0;
  questions = 0;
  reportedUsd = 0;
  estimatedUsd = 0;
  unknownCostCalls = 0;
  failures = 0;
  mockCalls = 0;
  private readonly sink?: (record: JevCallRecord) => void;

  constructor(sink?: (record: JevCallRecord) => void) {
    this.sink = sink;
  }

  get totalUsd(): number {
    return this.reportedUsd + this.estimatedUsd;
  }

  record(
    result: SystemOneResult,
    info: { command?: string; version?: number; extra?: Record<string, unknown> } = {},
  ): JevCallRecord {
    const questions = Object.keys(result.answers).length;
    this.calls++;
    this.questions += questions;
    const cost = result.meta.cost;
    if (cost.source === "reported") this.reportedUsd += cost.amount;
    else if (cost.source === "estimated") this.estimatedUsd += cost.amount;
    else if (cost.source === "mock") this.mockCalls++;
    else this.unknownCostCalls++;
    const record: JevCallRecord = {
      ...info,
      provider: result.meta.provider,
      model: result.meta.resolvedModel,
      answers: result.answers,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cost,
      elapsedMs: result.meta.elapsedMs,
      attempts: result.meta.attempts,
      questions,
    };
    this.sink?.(record);
    return record;
  }

  fail(
    error: unknown,
    info: {
      command?: string;
      version?: number;
      questions?: number;
      extra?: Record<string, unknown>;
    } = {},
  ): JevCallRecord {
    this.calls++;
    this.failures++;
    const record: JevCallRecord = {
      command: info.command,
      version: info.version,
      extra: info.extra,
      questions: info.questions ?? 0,
      cost: { amount: null, source: "unknown" },
      error: error instanceof Error ? error.message : String(error),
    };
    this.sink?.(record);
    return record;
  }

  summary(): string {
    return `${this.calls} jev calls, ${this.questions} questions, $${this.totalUsd.toFixed(6)}${this.failures ? `, ${this.failures} failed` : ""}`;
  }
}
