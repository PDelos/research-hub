// The code of the built-in plugins, by id (design v1-1 D1): static imports, so the server bundle includes them.
// Manifests stay files in plugins/<id>/rh-plugin.json; this map only says where each activation module is.
import type { PluginModule } from "./lifecycle.ts";

export const BUILTIN_MODULES: Record<string, () => Promise<PluginModule>> = {
  "rh.charter": () => import("../../plugins/rh.charter/main.ts") as Promise<PluginModule>,
  "rh.converter-docling": () => import("../../plugins/rh.converter-docling/main.ts") as Promise<PluginModule>,
  "rh.converter-pdf": () => import("../../plugins/rh.converter-pdf/main.ts") as Promise<PluginModule>,
  "rh.decision-jev": () => import("../../plugins/rh.decision-jev/main.ts") as Promise<PluginModule>,
  "rh.digest": () => import("../../plugins/rh.digest/main.ts") as Promise<PluginModule>,
  "rh.desk": () => import("../../plugins/rh.desk/main.ts") as Promise<PluginModule>,
  "rh.embedder-openrouter": () => import("../../plugins/rh.embedder-openrouter/main.ts") as Promise<PluginModule>,
  "rh.engineer": () => import("../../plugins/rh.engineer/main.ts") as Promise<PluginModule>,
  "rh.feedback": () => import("../../plugins/rh.feedback/main.ts") as Promise<PluginModule>,
  "rh.fulltext": () => import("../../plugins/rh.fulltext/main.ts") as Promise<PluginModule>,
  "rh.finder-method-transfer": () => import("../../plugins/rh.finder-method-transfer/main.ts") as Promise<PluginModule>,
  "rh.finder-missing-links": () => import("../../plugins/rh.finder-missing-links/main.ts") as Promise<PluginModule>,
  "rh.finder-rising-topics": () => import("../../plugins/rh.finder-rising-topics/main.ts") as Promise<PluginModule>,
  "rh.harness": () => import("../../plugins/rh.harness/main.ts") as Promise<PluginModule>,
  "rh.upgrades": () => import("../../plugins/rh.upgrades/main.ts") as Promise<PluginModule>,
  "rh.kb": () => import("../../plugins/rh.kb/main.ts") as Promise<PluginModule>,
  "rh.knowledge": () => import("../../plugins/rh.knowledge/main.ts") as Promise<PluginModule>,
  "rh.papers": () => import("../../plugins/rh.papers/main.ts") as Promise<PluginModule>,
  "rh.provider-openrouter": () => import("../../plugins/rh.provider-openrouter/main.ts") as Promise<PluginModule>,
  "rh.schedule": () => import("../../plugins/rh.schedule/main.ts") as Promise<PluginModule>,
  "rh.sweep": () => import("../../plugins/rh.sweep/main.ts") as Promise<PluginModule>,
  "rh.viewer-obsidian": () => import("../../plugins/rh.viewer-obsidian/main.ts") as Promise<PluginModule>,
};
