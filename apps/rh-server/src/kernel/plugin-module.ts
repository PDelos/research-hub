// What a plugin sees of the kernel (spec plugin-system; design D3): the context its `activate` gets, the module it
// exports, the disposables it registers, the errors it can meet, and how its code is loaded and torn down.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "../logger.ts";
import type { RhApi } from "./api.ts";
import { BUILTIN_MODULES } from "./builtins.ts";
import type { PluginManifest } from "./manifest.ts";
import { BUILTIN_PLUGINS_DIR, type DiscoveredPlugin } from "./registry.ts";

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface PluginContext {
  readonly id: string;
  readonly manifest: PluginManifest;
  /** The plugin's own folder (its code and assets). */
  readonly dir: string;
  /** The plugin's storage folder, data/plugins/data/<id>/ (not version-controlled). */
  readonly storageDir: string;
  /** The plugin's current settings (read again after a change). */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Only the values the project saved (no defaults): to tell "chosen" from "automatic". */
  readonly savedSettings: Readonly<Record<string, unknown>>;
  /**
   * Handle setting changes while running. Without a handler, a settings change restarts the plugin (deactivate,
   * activate); with one, the handler gets the new settings and the plugin keeps running.
   */
  onSettingsChange(handler: (settings: Readonly<Record<string, unknown>>) => void | Promise<void>): Disposable;
  /** Disposed in reverse order when the plugin is deactivated. */
  readonly subscriptions: Disposable[];
  /** What each dependency's `activate` returned, by plugin id. */
  readonly exports: Readonly<Record<string, unknown>>;
  readonly log: Logger;
  /** The kernel API. */
  readonly rh: RhApi;
  /** Built-in plugins only: the project's v0 objects they wrap (see builtin.ts). */
  readonly host?: unknown;
}

export interface PluginModule {
  activate?(context: PluginContext): unknown;
  deactivate?(): void | Promise<void>;
}

export class PluginUnavailable extends Error {
  constructor(
    readonly pluginId: string,
    readonly reason: string,
  ) {
    super(`${pluginId} is not available: ${reason}`);
    this.name = "PluginUnavailable";
  }
}

/** Disabling a plugin others depend on needs confirmation: these plugins would be disabled too. */
export class HasDependents extends Error {
  constructor(
    readonly pluginId: string,
    readonly dependents: string[],
  ) {
    super(`${dependents.join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on ${pluginId}`);
    this.name = "HasDependents";
  }
}

export async function defaultLoad(plugin: DiscoveredPlugin): Promise<PluginModule> {
  if (!plugin.manifest.main) return {};
  // The hub's own built-ins come from the static map (bundled); others are imported from their folder.
  const builtin = plugin.builtin ? BUILTIN_MODULES[plugin.manifest.id] : undefined;
  if (builtin && plugin.dir === join(BUILTIN_PLUGINS_DIR, plugin.manifest.id)) return builtin();
  return (await import(pathToFileURL(join(plugin.dir, plugin.manifest.main)).href)) as PluginModule;
}

export async function dispose(module: PluginModule | undefined, context: PluginContext, log: Logger): Promise<void> {
  try {
    await module?.deactivate?.();
  } catch (error) {
    log.warn("plugin.deactivate_failed", { error: String(error) });
  }
  for (const subscription of context.subscriptions.splice(0).toReversed()) {
    try {
      await subscription.dispose();
    } catch (error) {
      log.warn("plugin.dispose_failed", { error: String(error) });
    }
  }
}

export type SettingsHandler = (settings: Readonly<Record<string, unknown>>) => void | Promise<void>;

/** The context a plugin's `activate` gets: its folders, live settings, dependencies' exports and the rh API. */
export function pluginContext(input: {
  plugin: DiscoveredPlugin;
  storageDir: string;
  exports: Record<string, unknown>;
  log: Logger;
  settings: () => Readonly<Record<string, unknown>>;
  savedSettings: () => Readonly<Record<string, unknown>>;
  handlers: Set<SettingsHandler>;
  /** The API, given the list where what the plugin registers is kept (disposed on deactivate). */
  rh: (subscriptions: Disposable[]) => RhApi;
  host?: unknown;
}): PluginContext {
  const { plugin, handlers } = input;
  const subscriptions: Disposable[] = [];
  return {
    id: plugin.manifest.id,
    manifest: plugin.manifest,
    dir: plugin.dir,
    storageDir: input.storageDir,
    get settings() {
      return input.settings();
    },
    get savedSettings() {
      return input.savedSettings();
    },
    onSettingsChange(handler) {
      handlers.add(handler);
      const subscription = { dispose: () => void handlers.delete(handler) };
      subscriptions.push(subscription);
      return subscription;
    },
    subscriptions,
    exports: input.exports,
    log: input.log,
    rh: input.rh(subscriptions),
    ...(input.host !== undefined ? { host: input.host } : {}),
  };
}

/** The promise's value, or an error when it takes longer than `timeoutMs` (`what` names it in the message). */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs / 1000} s`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
