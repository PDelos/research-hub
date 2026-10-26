// The code of the built-in plugins, by id (design v1-1 D1): static imports, so the server bundle includes them.
// Manifests stay files in plugins/<id>/rh-plugin.json; this map only says where each activation module is.
import type { PluginModule } from "./lifecycle.ts";

export const BUILTIN_MODULES: Record<string, () => Promise<PluginModule>> = {
  "rh.charter": () => import("../../plugins/rh.charter/main.ts") as Promise<PluginModule>,
  "rh.decision-jev": () => import("../../plugins/rh.decision-jev/main.ts") as Promise<PluginModule>,
  "rh.desk": () => import("../../plugins/rh.desk/main.ts") as Promise<PluginModule>,
  "rh.embedder-openrouter": () => import("../../plugins/rh.embedder-openrouter/main.ts") as Promise<PluginModule>,
  "rh.feedback": () => import("../../plugins/rh.feedback/main.ts") as Promise<PluginModule>,
  "rh.kb": () => import("../../plugins/rh.kb/main.ts") as Promise<PluginModule>,
  "rh.papers": () => import("../../plugins/rh.papers/main.ts") as Promise<PluginModule>,
  "rh.provider-openrouter": () => import("../../plugins/rh.provider-openrouter/main.ts") as Promise<PluginModule>,
  "rh.schedule": () => import("../../plugins/rh.schedule/main.ts") as Promise<PluginModule>,
  "rh.sweep": () => import("../../plugins/rh.sweep/main.ts") as Promise<PluginModule>,
  "rh.viewer-obsidian": () => import("../../plugins/rh.viewer-obsidian/main.ts") as Promise<PluginModule>,
};
