import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import {
  createModelCatalog,
  installScriptedFaux,
  openDurableHarness,
  toPolicy,
  type FauxRule,
  type TelemetryStore,
} from "../src/index.ts";

export function tempDir(prefix = "rh-da-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function fauxHarness(dir: string, rules: FauxRule[], extensions: Extension[]) {
  const catalog = createModelCatalog({
    provider: "faux",
    installFaux: (models, modelIds) => installScriptedFaux(models, rules, { modelIds }),
  });
  const opened = await openDurableHarness({
    dbPath: join(dir, "agent.sqlite"),
    catalog,
    extensions,
    compaction: () => toPolicy(1_000_000),
  });
  const root = await opened.harness.root(opened.ctx, {
    agent: { model: catalog.defaultModel, thinkingLevel: "low" },
  });
  return { ...opened, catalog, root };
}

export async function ask(root: { submit: Function }, ctx: any, text: string, requestId?: string) {
  const submission = await (root as any).submit({ type: "input", content: text, requestId }, ctx);
  return submission.wait(ctx);
}

export function memoryTelemetry() {
  const rows = {
    conversations: new Map<number, any>(),
    generations: new Map<number, any>(),
    tools: new Map<number, any>(),
    users: new Map<number, any>(),
    tasks: new Map<number, any>(),
    other: new Map<number, any>(),
  };
  const store: TelemetryStore = {
    conversation: (r) => void rows.conversations.set(r.conversationId, r),
    generation: (r) => void rows.generations.set(r.entryId, r),
    toolResult: (r) => void rows.tools.set(r.entryId, r),
    userInput: (r) => void rows.users.set(r.entryId, r),
    task: (r) => void rows.tasks.set(r.taskId, { ...rows.tasks.get(r.taskId), ...r }),
    entry: (r) => void rows.other.set(r.entryId, r),
  };
  return { rows, store };
}

export const until = async (
  check: () => boolean | Promise<boolean>,
  ms = 10_000,
  label = "condition",
) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
