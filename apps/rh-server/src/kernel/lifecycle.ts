// Plugin activation and lifecycle (spec plugin-system: Lazy activation, Dependencies and exported APIs; design D3).
// The kernel reads every manifest without running code, resolves dependencies, and activates a plugin only when one
// of its activation events fires: dependencies first, `activate(context)` awaited with a 10 s timeout, a failure
// marking only that plugin (and its dependents) unavailable. Enabling and disabling at runtime commit to the plugin
// state and (de)activate without a restart; every change notifies listeners (the SSE `plugins` frame).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginRunState, PluginSummary } from "@rh/sdk";
import type { Logger } from "../logger.ts";
import type { RhApi } from "./api.ts";
import { dependents as dependentsOf, resolve, type GraphNode } from "./graph.ts";
import type { PluginManifest } from "./manifest.ts";
import { BUILTIN_MODULES } from "./builtins.ts";
import { BUILTIN_PLUGINS_DIR, builtinEntry, type Discovery, type DiscoveredPlugin } from "./registry.ts";
import { resolveSettings, SettingsInvalid, validateSettings } from "./settings.ts";
import { UndoRefused, type Actor, type Lockfile, type PluginState } from "./state.ts";

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

export interface KernelOptions {
  discovery: Discovery;
  state: PluginState;
  log: Logger;
  activationTimeoutMs?: number;
  /** Environment for settings defaults and first-start enablement (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Load a plugin's code; by default its `main` module is imported. */
  load?: (plugin: DiscoveredPlugin) => Promise<PluginModule>;
  /** Handed to built-in plugins as `context.host`. */
  builtinHost?: unknown;
  /** The `rh` API handed to a plugin; what it registers goes into `subscriptions` (disposed on deactivate). */
  api?: (plugin: DiscoveredPlugin, subscriptions: Disposable[]) => RhApi;
}

export { SettingsInvalid, UndoRefused };

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

interface Record_ {
  plugin: DiscoveredPlugin;
  state: PluginRunState;
  reason?: string;
  module?: PluginModule;
  context?: PluginContext;
  exports?: unknown;
  activatedAt?: string;
  activation?: Promise<unknown>;
  /** The settings the plugin last saw, to notice changes on re-apply. */
  settingsJson?: string;
  /** Live settings handlers registered through context.onSettingsChange. */
  settingsHandlers?: Set<(settings: Readonly<Record<string, unknown>>) => void | Promise<void>>;
}

function matches(events: string[], event: string): boolean {
  return events.includes(event) || (event === "onStartup" && events.includes("*"));
}

export class PluginKernel {
  private readonly records = new Map<string, Record_>();
  private readonly fired = new Set<string>();
  private readonly listeners = new Set<(plugins: PluginSummary[]) => void>();
  /** Activation order, to deactivate in reverse at shutdown. */
  private readonly activeOrder: string[] = [];
  private order: string[] = [];

  constructor(private readonly options: KernelOptions) {
    for (const [id, plugin] of options.discovery.plugins) this.records.set(id, { plugin, state: "inactive" });
  }

  /** Add built-ins missing from the lockfile (a new image), recompute states and fire `onStartup`. */
  async start(): Promise<void> {
    const lock = this.options.state.current();
    const missing = [...this.records.values()].filter((r) => r.plugin.builtin && !lock.plugins[r.plugin.manifest.id]);
    const forced = [...this.records.values()].filter(
      (r) => r.plugin.builtin && r.plugin.manifest.required && lock.plugins[r.plugin.manifest.id]?.enabled === false,
    );
    if (forced.length)
      await this.options.state.update(
        (lockfile) => {
          for (const r of forced) lockfile.plugins[r.plugin.manifest.id].enabled = true;
        },
        `re-enable required ${forced.map((r) => r.plugin.manifest.id).join(", ")}`,
        "kernel",
      );
    const stale = [...this.records.values()].filter(
      (r) =>
        r.plugin.builtin &&
        lock.plugins[r.plugin.manifest.id] &&
        lock.plugins[r.plugin.manifest.id].version !== r.plugin.manifest.version,
    );
    if (missing.length || stale.length)
      await this.options.state.update(
        (lockfile) => {
          for (const r of missing)
            lockfile.plugins[r.plugin.manifest.id] = builtinEntry(r.plugin.manifest, this.options.env);
          for (const r of stale) lockfile.plugins[r.plugin.manifest.id].version = r.plugin.manifest.version;
        },
        missing.length
          ? `add built-in ${missing.map((r) => r.plugin.manifest.id).join(", ")}`
          : "update built-in versions",
        "kernel",
      );
    this.recompute();
    await this.fire("onStartup");
  }

  list(): PluginSummary[] {
    return [...this.records.values()].map((r) => ({
      id: r.plugin.manifest.id,
      version: r.plugin.manifest.version,
      displayName: r.plugin.manifest.displayName,
      ...(r.plugin.manifest.description ? { description: r.plugin.manifest.description } : {}),
      builtin: r.plugin.builtin,
      kind: r.plugin.manifest.kind,
      topic: r.plugin.manifest.topic,
      ...(r.plugin.manifest.slot ? { slot: r.plugin.manifest.slot } : {}),
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.activatedAt ? { activatedAt: r.activatedAt } : {}),
    }));
  }

  get(id: string): PluginSummary | undefined {
    return this.list().find((p) => p.id === id);
  }

  manifest(id: string): PluginManifest | undefined {
    return this.records.get(id)?.plugin.manifest;
  }

  /** Plugins that are enabled and could run (not disabled, incompatible or blocked). */
  available(): string[] {
    return [...this.records.values()]
      .filter((r) => ["active", "activating", "inactive"].includes(r.state))
      .map((r) => r.plugin.manifest.id);
  }

  onChange(listener: (plugins: PluginSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fire an activation event: every available plugin listening for it is activated (failures are isolated). */
  async fire(event: string): Promise<void> {
    this.fired.add(event);
    const targets = this.order.filter((id) => {
      const entry = this.records.get(id)!;
      return entry.state === "inactive" && matches(entry.plugin.manifest.activationEvents, event);
    });
    await Promise.all(targets.map((id) => this.activate(id).catch(() => undefined)));
  }

  /** Activate a plugin (and its dependencies) and return its exports. */
  activate(id: string): Promise<unknown> {
    const pluginRecord = this.records.get(id);
    if (!pluginRecord) return Promise.reject(new PluginUnavailable(id, "not installed"));
    if (pluginRecord.state === "active") return Promise.resolve(pluginRecord.exports);
    if (pluginRecord.activation) return pluginRecord.activation;
    if (pluginRecord.state !== "inactive")
      return Promise.reject(new PluginUnavailable(id, pluginRecord.reason ?? pluginRecord.state));
    pluginRecord.activation = this.doActivate(pluginRecord).finally(() => (pluginRecord.activation = undefined));
    return pluginRecord.activation;
  }

  private async doActivate(entry: Record_): Promise<unknown> {
    const { manifest, dir } = entry.plugin;
    const exports: Record<string, unknown> = {};
    for (const dep of Object.keys(manifest.dependencies)) exports[dep] = await this.activate(dep);
    const log = this.options.log.child({ plugin: manifest.id });
    this.set(entry, "activating");
    const storageDir = join(this.options.state.dir, "data", manifest.id);
    const settings = this.settings(manifest.id);
    const timeoutMs = this.options.activationTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let context: PluginContext | undefined;
    try {
      const module = await (this.options.load ?? defaultLoad)(entry.plugin);
      const subscriptions: Disposable[] = [];
      mkdirSync(storageDir, { recursive: true });
      const handlers = new Set<(settings: Readonly<Record<string, unknown>>) => void | Promise<void>>();
      entry.settingsHandlers = handlers;
      const current = () => this.settings(manifest.id);
      const saved = () => structuredClone(this.options.state.current().plugins[manifest.id]?.settings ?? {});
      context = {
        id: manifest.id,
        manifest,
        dir,
        storageDir,
        get settings() {
          return current();
        },
        get savedSettings() {
          return saved();
        },
        onSettingsChange(handler) {
          handlers.add(handler);
          const subscription = { dispose: () => void handlers.delete(handler) };
          subscriptions.push(subscription);
          return subscription;
        },
        subscriptions,
        exports,
        log,
        // Without an API factory (unit tests of the lifecycle) plugins get no `rh`.
        rh: this.options.api?.(entry.plugin, subscriptions) as RhApi,
        ...(entry.plugin.builtin && this.options.builtinHost !== undefined ? { host: this.options.builtinHost } : {}),
      };
      const result = await Promise.race([
        Promise.resolve(module.activate?.(context)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`activation timed out after ${timeoutMs / 1000} s`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (entry.state !== "activating") {
        // Disabled while activating: undo.
        await dispose(module, context, log);
        throw new PluginUnavailable(manifest.id, entry.reason ?? entry.state);
      }
      Object.assign(entry, {
        module,
        context,
        exports: result,
        activatedAt: new Date().toISOString(),
        settingsJson: JSON.stringify(settings),
      });
      this.activeOrder.push(manifest.id);
      log.info("plugin.activated", { version: manifest.version });
      this.set(entry, "active");
      return result;
    } catch (error) {
      if (error instanceof PluginUnavailable) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log.warn("plugin.activation_failed", { error: message });
      if (context) await dispose(undefined, context, log);
      this.set(entry, "failed", message);
      this.recompute();
      throw new PluginUnavailable(manifest.id, `failed: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Deactivate a plugin, its active dependents first. */
  async deactivate(id: string): Promise<void> {
    const pluginRecord = this.records.get(id);
    if (!pluginRecord) return;
    const deps = new Set(dependentsOf(this.nodes(), id));
    for (const dependent of this.activeOrder.filter((d) => deps.has(d)).toReversed())
      await this.deactivateOne(dependent);
    await this.deactivateOne(id);
  }

  private async deactivateOne(id: string): Promise<void> {
    const entry = this.records.get(id)!;
    if (entry.activation) await entry.activation.catch(() => undefined);
    if (entry.state !== "active") return;
    const log = this.options.log.child({ plugin: id });
    await dispose(entry.module, entry.context!, log);
    Object.assign(entry, {
      module: undefined,
      context: undefined,
      exports: undefined,
      activatedAt: undefined,
      settingsJson: undefined,
      settingsHandlers: undefined,
    });
    this.activeOrder.splice(this.activeOrder.indexOf(id), 1);
    log.info("plugin.deactivated", {});
    this.set(entry, "inactive");
  }

  /**
   * Enable or disable a plugin (one commit). Disabling a plugin that enabled plugins depend on throws HasDependents
   * unless `cascade` confirms disabling them too.
   */
  async setEnabled(id: string, enabled: boolean, options: { actor?: Actor; cascade?: boolean } = {}): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new PluginUnavailable(id, "not installed");
    if (!enabled && record.plugin.builtin && record.plugin.manifest.required)
      throw new PluginUnavailable(id, "the hub needs it, so it cannot be disabled");
    const lock = this.options.state.current();
    const affected = enabled ? [] : dependentsOf(this.nodes(), id).filter((d) => lock.plugins[d]?.enabled);
    const requiredDependent = affected.find((d) => this.records.get(d)?.plugin.manifest.required);
    if (requiredDependent) throw new PluginUnavailable(id, `${requiredDependent} needs it, so it cannot be disabled`);
    if (affected.length && !options.cascade) throw new HasDependents(id, affected);
    const ids = [id, ...affected];
    await this.options.state.update(
      (lockfile) => {
        for (const p of ids) if (lockfile.plugins[p]) lockfile.plugins[p].enabled = enabled;
      },
      `${enabled ? "enable" : "disable"} ${ids.join(", ")}`,
      options.actor ?? "user",
    );
    await this.apply();
  }

  /** Re-apply the current lockfile (after enable, disable, a settings change or a rollback). */
  async apply(): Promise<void> {
    const lock = this.options.state.current();
    // Deactivate what is now disabled or configured differently, dependents first.
    for (const id of this.activeOrder.toReversed()) {
      const entry = lock.plugins[id];
      const pluginRecord = this.records.get(id)!;
      if (!entry?.enabled) {
        await this.deactivate(id);
        continue;
      }
      const settings = this.settings(id);
      const json = JSON.stringify(settings);
      if (json === pluginRecord.settingsJson) continue;
      if (pluginRecord.settingsHandlers?.size) {
        pluginRecord.settingsJson = json;
        for (const handler of pluginRecord.settingsHandlers) {
          try {
            await handler(settings);
          } catch (error) {
            this.options.log.warn("plugin.settings_handler_failed", { plugin: id, error: String(error) });
          }
        }
      } else await this.deactivate(id);
    }
    // A failed plugin gets a fresh chance once it is enabled again or reconfigured.
    for (const r of this.records.values()) if (r.state === "failed") this.set(r, "inactive");
    this.recompute();
    for (const event of this.fired) await this.fire(event);
  }

  /** A plugin's effective settings: schema defaults, environment defaults, then saved values. */
  settings(id: string): Record<string, unknown> {
    const pluginRecord = this.records.get(id);
    if (!pluginRecord) throw new PluginUnavailable(id, "not installed");
    return resolveSettings(
      pluginRecord.plugin.manifest,
      this.options.state.current().plugins[id]?.settings ?? {},
      this.options.env,
    );
  }

  /**
   * Change some of a plugin's settings (one commit, validated first: SettingsInvalid names the setting and the
   * rule); a running plugin is restarted with the new values. `undefined` removes a saved value.
   */
  async configure(id: string, changes: Record<string, unknown>, actor: Actor = "user"): Promise<void> {
    const pluginRecord = this.records.get(id);
    if (!pluginRecord) throw new PluginUnavailable(id, "not installed");
    const saved = { ...this.options.state.current().plugins[id]?.settings };
    for (const [key, value] of Object.entries(changes))
      if (value === undefined) delete saved[key];
      else saved[key] = value;
    validateSettings(
      pluginRecord.plugin.manifest,
      resolveSettings(pluginRecord.plugin.manifest, saved, this.options.env),
    );
    await this.options.state.update(
      (lockfile) => {
        if (!lockfile.plugins[id]) throw new PluginUnavailable(id, "not in the lockfile");
        lockfile.plugins[id].settings = saved;
      },
      `configure ${id}: ${Object.keys(changes).join(", ")}`,
      actor,
    );
    await this.apply();
  }

  /**
   * Undo one change (a commit) and re-apply the state; later changes stay. Restoring a plugin whose files are gone
   * (an uninstall) is refused: install it again instead.
   */
  async undo(commitId: string, actor: Actor = "user"): Promise<{ id: string | undefined; plugins: string[] }> {
    const preview = await this.options.state.at(commitId).catch(() => undefined);
    if (!preview) throw new UndoRefused(`no change ${commitId}`);
    const result = await this.options.state.revert(commitId, actor, (next) => {
      const missing = Object.keys(next.plugins).filter((id) => !this.records.has(id));
      if (missing.length)
        throw new UndoRefused(`${missing.join(", ")} is no longer installed; install it again instead`);
    });
    await this.apply();
    return { id: result.id, plugins: result.plugins };
  }

  /** Roll the plugin state back to commit `commitId` and re-apply it. */
  async rollback(commitId: string, actor: Actor = "user"): Promise<void> {
    await this.options.state.rollback(commitId, actor);
    await this.apply();
  }

  /**
   * Mark a running plugin failed from outside (its process crashed or hung): what it registered is disposed, its
   * dependents are deactivated and blocked, and the reason is shown. Enabling it again gives it a fresh start.
   */
  async markFailed(id: string, reason: string): Promise<void> {
    const pluginRecord = this.records.get(id);
    if (!pluginRecord || (pluginRecord.state !== "active" && pluginRecord.state !== "activating")) return;
    const deps = new Set(dependentsOf(this.nodes(), id));
    for (const dependent of this.activeOrder.filter((d) => deps.has(d)).toReversed())
      await this.deactivateOne(dependent);
    if (pluginRecord.state === "active") {
      const log = this.options.log.child({ plugin: id });
      if (pluginRecord.context) await dispose(undefined, pluginRecord.context, log);
      Object.assign(pluginRecord, {
        module: undefined,
        context: undefined,
        exports: undefined,
        activatedAt: undefined,
        settingsJson: undefined,
        settingsHandlers: undefined,
      });
      this.activeOrder.splice(this.activeOrder.indexOf(id), 1);
    }
    this.options.log.warn("plugin.failed", { plugin: id, reason });
    this.set(pluginRecord, "failed", reason);
    this.recompute();
  }

  /** Add a newly installed plugin (not active until enabled in the lockfile and its events fire). */
  add(plugin: DiscoveredPlugin): void {
    this.options.discovery.plugins.set(plugin.manifest.id, plugin);
    this.records.set(plugin.manifest.id, { plugin, state: "inactive" });
    this.recompute();
  }

  /** Remove an uninstalled plugin (deactivate it first). */
  remove(id: string): void {
    this.options.discovery.plugins.delete(id);
    this.records.delete(id);
    this.recompute();
    this.emit();
  }

  /** Deactivate every plugin, most recently activated first. */
  async stop(): Promise<void> {
    for (const id of this.activeOrder.toReversed()) await this.deactivateOne(id);
  }

  private nodes(lock: Lockfile = this.options.state.current()): Map<string, GraphNode> {
    return new Map(
      [...this.records].map(([id, r]) => [
        id,
        {
          manifest: r.plugin.manifest,
          enabled: lock.plugins[id]?.enabled ?? false,
          ...problemOf(r),
        },
      ]),
    );
  }

  /** Derive every non-running plugin's state from the lockfile and the dependency graph. */
  private recompute(): void {
    const { order, blocked } = resolve(this.nodes());
    this.order = order;
    let changed = false;
    for (const [id, r] of this.records) {
      if (r.state === "active" || r.state === "activating" || r.state === "failed") continue;
      const reason = blocked.get(id);
      const next = idleState(reason, !!r.plugin.incompatible);
      if (r.state !== next[0] || r.reason !== next[1]) {
        r.state = next[0];
        r.reason = next[1];
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private set(entry: Record_, state: PluginRunState, reason?: string): void {
    entry.state = state;
    entry.reason = reason;
    this.emit();
  }

  private emit(): void {
    const plugins = this.list();
    for (const listener of this.listeners) {
      try {
        listener(plugins);
      } catch (error) {
        this.options.log.warn("plugin.listener_failed", { error: String(error) });
      }
    }
  }
}

export async function defaultLoad(plugin: DiscoveredPlugin): Promise<PluginModule> {
  if (!plugin.manifest.main) return {};
  // The hub's own built-ins come from the static map (bundled); others are imported from their folder.
  const builtin = plugin.builtin ? BUILTIN_MODULES[plugin.manifest.id] : undefined;
  if (builtin && plugin.dir === join(BUILTIN_PLUGINS_DIR, plugin.manifest.id)) return builtin();
  return (await import(pathToFileURL(join(plugin.dir, plugin.manifest.main)).href)) as PluginModule;
}

async function dispose(module: PluginModule | undefined, context: PluginContext, log: Logger): Promise<void> {
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

/** What the Plugins tab shows as a plugin's problem, if any. */
function problemOf(record: { plugin: { incompatible?: string }; state: string; reason?: string }): {
  problem?: string;
} {
  if (record.plugin.incompatible) return { problem: record.plugin.incompatible };
  if (record.state === "failed") return { problem: `failed: ${record.reason}` };
  return {};
}

/** The state of a plugin that is not running, from why it is held back (if it is). */
function idleState(reason: string | undefined, incompatible: boolean): [PluginRunState, string | undefined] {
  if (reason === undefined) return ["inactive", undefined];
  if (reason === "disabled") return ["disabled", undefined];
  return [incompatible ? "incompatible" : "blocked", reason];
}
