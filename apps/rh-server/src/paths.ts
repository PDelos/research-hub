// Where the server's files live on disk: the folder holding prompt_engineering/ (apps/rh-server), found from this
// module whether it runs from src/ (tsx, tests) or from the bundle in dist/ (the image).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findAppDir(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, "prompt_engineering")) && existsSync(join(dir, "plugins"))) return dir;
    const up = dirname(dir);
    if (up === dir)
      throw new Error(`cannot find the server folder (prompt_engineering/, plugins/) above ${import.meta.dirname}`);
    dir = up;
  }
}

/** apps/rh-server: prompts, Jev commands, the vault template, built-in plugin manifests, helper scripts. */
export const APP_DIR = findAppDir();
/** The repository (or image) root: package.json and the default .env. */
export const REPO_ROOT = resolve(APP_DIR, "../..");
/** Helper scripts run as separate processes (kept as files, never bundled). */
export const PLUGIN_RUNNER = join(APP_DIR, "src", "kernel", "plugin-runner.mjs");
export const LOOPBACK_PRELOAD = join(APP_DIR, "src", "kb", "loopback.cjs");
