// Plugin discovery (spec plugin-system; design D8): built-in plugins ship in apps/rh-server/plugins/<id>/, external
// ones are installed under $RH_DATA_DIR/plugins/installed/<id>/. Each folder holds an rh-plugin.json; invalid
// manifests are reported with their problems instead of stopping the hub.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { contributionProblems } from "./contributions.ts";
import { engineProblem, loadManifest, ManifestInvalid, type PluginManifest } from "./manifest.ts";
import { initiallyEnabled } from "./settings.ts";
import type { LockEntry } from "./state.ts";

export const BUILTIN_PLUGINS_DIR = join(import.meta.dirname, "..", "..", "plugins");

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  builtin: boolean;
  /** Set when the kernel API is outside the plugin's engines range. */
  incompatible?: string;
}

export interface InvalidPlugin {
  dir: string;
  builtin: boolean;
  problems: string[];
}

export interface Discovery {
  plugins: Map<string, DiscoveredPlugin>;
  invalid: InvalidPlugin[];
}

export function discover(options: { builtinDir?: string; installedDir?: string; kernel?: string }): Discovery {
  const plugins = new Map<string, DiscoveredPlugin>();
  const invalid: InvalidPlugin[] = [];
  const scan = (root: string | undefined, builtin: boolean) => {
    if (!root || !existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(root, entry.name);
      try {
        const manifest = loadManifest(dir);
        if (plugins.has(manifest.id)) {
          invalid.push({
            dir,
            builtin,
            problems: [`id: ${manifest.id} is already provided by ${plugins.get(manifest.id)!.dir}`],
          });
          continue;
        }
        const problems = contributionProblems(manifest, dir);
        if (problems.length) {
          invalid.push({ dir, builtin, problems });
          continue;
        }
        const incompatible = engineProblem(manifest, options.kernel);
        plugins.set(manifest.id, { manifest, dir, builtin, ...(incompatible ? { incompatible } : {}) });
      } catch (error) {
        if (!(error instanceof ManifestInvalid)) throw error;
        invalid.push({ dir, builtin, problems: error.problems });
      }
    }
  };
  // Built-ins first: an installed plugin cannot shadow a built-in id.
  scan(options.builtinDir ?? BUILTIN_PLUGINS_DIR, true);
  scan(options.installedDir, false);
  return { plugins, invalid };
}

/** The lockfile entry a built-in plugin gets when a project first sees it (enabled unless its environment switch is off). */
export function builtinEntry(manifest: PluginManifest, env: NodeJS.ProcessEnv = process.env): LockEntry {
  return {
    version: manifest.version,
    source: { kind: "builtin" },
    enabled: initiallyEnabled(manifest, env),
    settings: {},
  };
}

/** The first lockfile of a project: every built-in plugin (an existing v0 project keeps all its features). */
export function initialPlugins(discovery: Discovery, env: NodeJS.ProcessEnv = process.env): Record<string, LockEntry> {
  return Object.fromEntries(
    [...discovery.plugins.values()].filter((p) => p.builtin).map((p) => [p.manifest.id, builtinEntry(p.manifest, env)]),
  );
}
