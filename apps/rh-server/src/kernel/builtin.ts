// What built-in plugins receive besides the rh API (design D8): the project's v0 objects, which their activation
// modules wrap. External plugins never see this; they only get `context.rh`.
import type { Context } from "@earendil-works/chord";
import type { Extension } from "@earendil-works/pi-durable";
import type { DurableHarness } from "@rh/durable-agent";
import type { Settings, Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { OpenProjectOptions } from "../project.ts";
import type { Telemetry } from "../telemetry.ts";
import type { KernelServices } from "./api.ts";
import type { PluginContext } from "./lifecycle.ts";

export interface BuiltinHost {
  name: string;
  dir: string;
  db: Db;
  settings: Settings;
  telemetry: Telemetry;
  log: Logger;
  offline: boolean;
  options: OpenProjectOptions;
  services: KernelServices;
  /** The observability extension every agent shares (run telemetry and logs). */
  observe: Extension;
  /** Activate another plugin and get its exports (for extension point contributions). */
  exportsOf<T>(id: string): Promise<T>;
}

export function hostOf(context: PluginContext): BuiltinHost {
  if (!context.host) throw new Error(`${context.id} is not a built-in plugin`);
  return context.host as BuiltinHost;
}

/** What built-in plugins may export for the project's agent runtime, which the kernel opens after activation. */
export interface AgentHooks {
  /** Extensions for the research desk's conversation (tools, sections). */
  agentExtensions?: Extension[];
  /** Agents with their own conversations (charter writer, card writer, librarian). */
  separateExtensions?: Extension[];
  /** Called once the runtime is open and resumed. */
  attach?(harness: DurableHarness["harness"], ctx: Context): void;
  /** Called last, when the project is ready (background work starts here). */
  ready?(): void;
}
