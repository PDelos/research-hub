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
import { builtinEntry, type Discovery, type DiscoveredPlugin } from "./registry.ts";
import { resolveSettings, SettingsInvalid, validateSettings } from "./settings.ts";
import type { Actor, Lockfile, PluginState } from "./state.ts";

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

export { SettingsInvalid };

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
        (l) => {
          for (const r of forced) l.plugins[r.plugin.manifest.id].enabled = true;
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
        (l) => {
          for (const r of missing) l.plugins[r.plugin.manifest.id] = builtinEntry(r.plugin.manifest, this.options.env);
          for (const r of stale) l.plugins[r.plugin.manifest.id].version = r.plugin.manifest.version;
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

  onChange(fn: (plugins: PluginSummary[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fire an activation event: every available plugin listening for it is activated (failures are isolated). */
  async fire(event: string): Promise<void> {
    this.fired.add(event);
    const targets = this.order.filter((id) => {
      const r = this.records.get(id)!;
      return r.state === "inactive" && matches(r.plugin.manifest.activationEvents, event);
    });
    await Promise.all(targets.map((id) => this.activate(id).catch(() => undefined)));
  }

  /** Activate a plugin (and its dependencies) and return its exports. */
  activate(id: string): Promise<unknown> {
    const r = this.records.get(id);
    if (!r) return Promise.reject(new PluginUnavailable(id, "not installed"));
    if (r.state === "active") return Promise.resolve(r.exports);
    if (r.activation) return r.activation;
    if (r.state !== "inactive") return Promise.reject(new PluginUnavailable(id, r.reason ?? r.state));
    r.activation = this.doActivate(r).finally(() => (r.activation = undefined));
    return r.activation;
  }

  private async doActivate(r: Record_): Promise<unknown> {
    const { manifest, dir } = r.plugin;
    const exports: Record<string, unknown> = {};
    for (const dep of Object.keys(manifest.dependencies)) exports[dep] = await this.activate(dep);
    const log = this.options.log.child({ plugin: manifest.id });
    this.set(r, "activating");
    const storageDir = join(this.options.state.dir, "data", manifest.id);
    const settings = this.settings(manifest.id);
    const timeoutMs = this.options.activationTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let context: PluginContext | undefined;
    try {
      const module = await (this.options.load ?? defaultLoad)(r.plugin);
      const subscriptions: Disposable[] = [];
      mkdirSync(storageDir, { recursive: true });
      const handlers = new Set<(settings: Readonly<Record<string, unknown>>) => void | Promise<void>>();
      r.settingsHandlers = handlers;
      const current = () => this.settings(manifest.id);
      context = {
        id: manifest.id,
        manifest,
        dir,
        storageDir,
        get settings() {
          return current();
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
        rh: this.options.api?.(r.plugin, subscriptions) as RhApi,
        ...(r.plugin.builtin && this.options.builtinHost !== undefined ? { host: this.options.builtinHost } : {}),
      };
      const result = await Promise.race([
        Promise.resolve(module.activate?.(context)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`activation timed out after ${timeoutMs / 1000} s`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (r.state !== "activating") {
        // Disabled while activating: undo.
        await dispose(module, context, log);
        throw new PluginUnavailable(manifest.id, r.reason ?? r.state);
      }
      Object.assign(r, {
        module,
        context,
        exports: result,
        activatedAt: new Date().toISOString(),
        settingsJson: JSON.stringify(settings),
      });
      this.activeOrder.push(manifest.id);
      log.info("plugin.activated", { version: manifest.version });
      this.set(r, "active");
      return result;
    } catch (error) {
      if (error instanceof PluginUnavailable) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log.warn("plugin.activation_failed", { error: message });
      if (context) await dispose(undefined, context, log);
      this.set(r, "failed", message);
      this.recompute();
      throw new PluginUnavailable(manifest.id, `failed: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Deactivate a plugin, its active dependents first. */
  async deactivate(id: string): Promise<void> {
    const r = this.records.get(id);
    if (!r) return;
    const deps = new Set(dependentsOf(this.nodes(), id));
    for (const dependent of this.activeOrder.filter((d) => deps.has(d)).toReversed())
      await this.deactivateOne(dependent);
    await this.deactivateOne(id);
  }

  private async deactivateOne(id: string): Promise<void> {
    const r = this.records.get(id)!;
    if (r.activation) await r.activation.catch(() => undefined);
    if (r.state !== "active") return;
    const log = this.options.log.child({ plugin: id });
    await dispose(r.module, r.context!, log);
    Object.assign(r, {
      module: undefined,
      context: undefined,
      exports: undefined,
      activatedAt: undefined,
      settingsJson: undefined,
      settingsHandlers: undefined,
    });
    this.activeOrder.splice(this.activeOrder.indexOf(id), 1);
    log.info("plugin.deactivated", {});
    this.set(r, "inactive");
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
      (l) => {
        for (const p of ids) if (l.plugins[p]) l.plugins[p].enabled = enabled;
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
      const r = this.records.get(id)!;
      if (!entry?.enabled) {
        await this.deactivate(id);
        continue;
      }
      const settings = this.settings(id);
      const json = JSON.stringify(settings);
      if (json === r.settingsJson) continue;
      if (r.settingsHandlers?.size) {
        r.settingsJson = json;
        for (const handler of r.settingsHandlers) {
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
    const r = this.records.get(id);
    if (!r) throw new PluginUnavailable(id, "not installed");
    return resolveSettings(
      r.plugin.manifest,
      this.options.state.current().plugins[id]?.settings ?? {},
      this.options.env,
    );
  }

  /**
   * Change some of a plugin's settings (one commit, validated first: SettingsInvalid names the setting and the
   * rule); a running plugin is restarted with the new values. `undefined` removes a saved value.
   */
  async configure(id: string, changes: Record<string, unknown>, actor: Actor = "user"): Promise<void> {
    const r = this.records.get(id);
    if (!r) throw new PluginUnavailable(id, "not installed");
    const saved = { ...this.options.state.current().plugins[id]?.settings };
    for (const [key, value] of Object.entries(changes))
      if (value === undefined) delete saved[key];
      else saved[key] = value;
    validateSettings(r.plugin.manifest, resolveSettings(r.plugin.manifest, saved, this.options.env));
    await this.options.state.update(
      (l) => {
        if (!l.plugins[id]) throw new PluginUnavailable(id, "not in the lockfile");
        l.plugins[id].settings = saved;
      },
      `configure ${id}: ${Object.keys(changes).join(", ")}`,
      actor,
    );
    await this.apply();
  }

  /** Roll the plugin state back to commit `commitId` and re-apply it. */
  async rollback(commitId: string, actor: Actor = "user"): Promise<void> {
    await this.options.state.rollback(commitId, actor);
    await this.apply();
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
          ...(r.plugin.incompatible
            ? { problem: r.plugin.incompatible }
            : r.state === "failed"
              ? { problem: `failed: ${r.reason}` }
              : {}),
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
      const next: [PluginRunState, string | undefined] =
        reason === undefined
          ? ["inactive", undefined]
          : reason === "disabled"
            ? ["disabled", undefined]
            : r.plugin.incompatible
              ? ["incompatible", reason]
              : ["blocked", reason];
      if (r.state !== next[0] || r.reason !== next[1]) {
        r.state = next[0];
        r.reason = next[1];
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private set(r: Record_, state: PluginRunState, reason?: string): void {
    r.state = state;
    r.reason = reason;
    this.emit();
  }

  private emit(): void {
    const plugins = this.list();
    for (const fn of this.listeners) {
      try {
        fn(plugins);
      } catch (error) {
        this.options.log.warn("plugin.listener_failed", { error: String(error) });
      }
    }
  }
}

async function defaultLoad(plugin: DiscoveredPlugin): Promise<PluginModule> {
  if (!plugin.manifest.main) return {};
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
