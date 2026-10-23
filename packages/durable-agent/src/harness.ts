// openDurableHarness: one pi-durable Harness on SQLite (WAL) with the app's extensions,
// live compaction, retries and a PID lock. Agents get no bash or file tools unless the app adds them.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  Harness,
  type ConversationRecord,
  type Extension,
  type Registry,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { CompactionPolicyShape } from "./compaction.ts";
import { lockFile } from "./lock.ts";
import type { ModelCatalog } from "./models.ts";
import { type LoggerLike, silentLogger } from "./observability/types.ts";

export interface DurableHarnessOptions {
  dbPath: string;
  catalog: ModelCatalog;
  /** Installed in order; also the default selection for new conversations unless `defaults` is given. */
  extensions: readonly Extension[];
  defaults?: readonly Extension[];
  /** Read before every request, so a change applies from the next one. */
  compaction: () => CompactionPolicyShape;
  logger?: LoggerLike;
  now?: () => number;
  conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
  maxRetries?: number;
}

export interface DurableHarness {
  readonly harness: Harness;
  readonly registry: Registry;
  readonly ctx: Context;
  close(): Promise<void>;
}

export async function openDurableHarness(options: DurableHarnessOptions): Promise<DurableHarness> {
  const log = options.logger ?? silentLogger;
  const unlock = lockFile(`${options.dbPath}.lock`);
  const registry = createRegistry();
  for (const extension of options.extensions) registry.install(extension);
  const ctx = BACKGROUND_CONTEXT;
  let harness: Harness;
  try {
    harness = await Harness.open(
      await openNodeSqliteStorage(options.dbPath),
      {
        models: options.catalog.models,
        registry,
        settings: {
          extensions: options.defaults ?? options.extensions,
          stream: { timeoutMs: 180_000, maxRetries: 2 },
          retry: {
            enabled: true,
            maxRetries: options.maxRetries ?? 4,
            baseDelayMs: 2000,
            maxAgentDelayMs: 60_000,
          },
          get compaction() {
            return options.compaction();
          },
          progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
          toolExecution: "parallel",
        },
        now: options.now,
        conversationCreated: options.conversationCreated,
        onReport: (error) => log.error("durable.report", { error }),
      },
      ctx,
    );
  } catch (error) {
    unlock();
    throw error;
  }
  let closed = false;
  return {
    harness,
    registry,
    ctx,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await harness.close(ctx);
      } finally {
        unlock();
      }
    },
  };
}
