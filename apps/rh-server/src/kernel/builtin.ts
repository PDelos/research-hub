// What built-in plugins receive besides the rh API (design D8): the project's v0 objects, which their activation
// modules wrap. External plugins never see this; they only get `context.rh`.
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
}

export function hostOf(context: PluginContext): BuiltinHost {
  if (!context.host) throw new Error(`${context.id} is not a built-in plugin`);
  return context.host as BuiltinHost;
}
