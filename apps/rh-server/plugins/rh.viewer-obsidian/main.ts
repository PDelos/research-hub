// Built-in plugin rh.viewer-obsidian: the kb.viewer contribution "obsidian". It supervises Ignis (the v0 viewer
// supervisor) while it is the active viewer, and pauses it otherwise or when the plugin is disabled.
import { join } from "node:path";
import { KbViewer } from "../../src/kb/viewer.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { KbExports } from "../rh.kb/main.ts";

export function activate(context: PluginContext): void {
  const host = hostOf(context);
  const { options } = host;
  const kb = context.exports["rh.kb"] as KbExports;
  const kbViewer = new KbViewer({
    enabled: options.kbViewer?.enabled ?? false,
    ignisDir: options.kbViewer?.dir ?? "/opt/ignis",
    stateDir: join(host.dir, "kb-viewer"),
    vaultDir: kb.vault.dir,
    projectName: host.name,
    obsidianVersion: options.kbViewer?.obsidianVersion ?? "1.14.4",
    offline: options.offline,
    log: host.log.child({ component: "kb-viewer" }),
    restartDelays: options.kbViewer?.restartDelays,
  });
  context.subscriptions.push(
    kb.registerViewer("obsidian", {
      kbViewer,
      show: () => kbViewer.resume(),
      hide: (reason) => kbViewer.pause(reason),
    }),
    // Registered last, so it runs first on deactivate: the process stops before the viewer is unregistered.
    { dispose: () => kbViewer.pause("the Obsidian viewer plugin is disabled") },
  );
}
