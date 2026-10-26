// The plugin host of one project (design D2, D3, D7): discovery of built-in and installed plugins, the git-backed
// plugin state in $RH_DATA_DIR/plugins, the kernel with its rh API, and the contribution registry. openProject
// starts it before anything else, so built-in plugins provide the v0 services the project exposes.
import { join } from "node:path";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import { createRhApi, EventBus, ScheduleRegistry, type KernelServices } from "./api.ts";
import { ContributionRegistry } from "./contributions.ts";
import { defaultLoad, PluginKernel } from "./lifecycle.ts";
import { externalModule } from "./plugin-process.ts";
import { Budgets } from "./permissions.ts";
import { discover, initialPlugins, type Discovery } from "./registry.ts";
import { PluginInstaller } from "./install.ts";
import { hashFolder, PluginState } from "./state.ts";

export interface PluginHostOptions {
  dataDir: string;
  db: Db;
  vaultDir: string;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  /** Built-in plugins folder (default apps/rh-server/plugins). */
  builtinDir?: string;
  /** What built-in plugins receive as `context.host`, given the kernel services and a way to reach other plugins. */
  builtinHost?: (services: KernelServices, exportsOf: <T>(id: string) => Promise<T>) => unknown;
  fetch?: typeof fetch;
  activationTimeoutMs?: number;
  /** Longest wait for an answer from an external plugin's process (default 30 s). */
  pluginCallTimeoutMs?: number;
}

export interface PluginHost {
  readonly kernel: PluginKernel;
  readonly contributions: ContributionRegistry;
  readonly services: KernelServices;
  readonly discovery: Discovery;
  readonly state: PluginState;
  readonly installer: PluginInstaller;
  /** What an active plugin's activate returned. */
  exportsOf<T>(id: string): Promise<T>;
  stop(): Promise<void>;
}

export async function startPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const env = options.env ?? process.env;
  const log = options.log.child({ component: "plugins" });
  const state = new PluginState(options.dataDir);
  const discovery = discover({
    ...(options.builtinDir ? { builtinDir: options.builtinDir } : {}),
    installedDir: join(state.dir, "installed"),
  });
  for (const invalid of discovery.invalid) log.warn("plugin.invalid", { dir: invalid.dir, problems: invalid.problems });
  await state.open(() => initialPlugins(discovery, env));
  // An installed plugin whose files changed since it was approved does not run (tampering or a manual edit).
  for (const plugin of discovery.plugins.values()) {
    const locked = state.current().plugins[plugin.manifest.id];
    if (plugin.builtin || !locked?.hash || plugin.incompatible) continue;
    if (hashFolder(plugin.dir) !== locked.hash)
      plugin.incompatible = "its files changed since it was installed; reinstall it";
  }
  const events = new EventBus(log);
  const services: KernelServices = {
    db: options.db,
    vaultDir: options.vaultDir,
    storageRoot: join(state.dir, "data"),
    env,
    log,
    events,
    budgets: new Budgets(options.db, {
      onExceeded: (pluginId, limitUsd) => {
        log.warn("plugin.budget_exceeded", { plugin: pluginId, limitUsd });
        events.emit("budget.exceeded", { pluginId, limitUsd });
      },
    }),
    contributions: undefined as unknown as ContributionRegistry,
    schedules: new ScheduleRegistry(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    providers: {},
  };
  const exportsOf = <T>(id: string) => kernel.activate(id) as Promise<T>;
  const kernel: PluginKernel = new PluginKernel({
    discovery,
    state,
    log,
    env,
    ...(options.activationTimeoutMs ? { activationTimeoutMs: options.activationTimeoutMs } : {}),
    builtinHost: options.builtinHost?.(services, exportsOf),
    // Built-ins run in the kernel's process; every other plugin in its own restricted process (design D6).
    load: async (plugin) =>
      plugin.builtin
        ? defaultLoad(plugin)
        : externalModule(plugin, {
            log,
            onFailure: (id, reason) => kernel.markFailed(id, reason),
            ...(options.pluginCallTimeoutMs ? { callTimeoutMs: options.pluginCallTimeoutMs } : {}),
          }),
    api: (plugin, subscriptions) => createRhApi(plugin, services, subscriptions),
  });
  const contributions = new ContributionRegistry(kernel, discovery);
  services.contributions = contributions;
  await kernel.start();
  for (const p of kernel.list())
    if (p.state === "failed" || p.state === "blocked" || p.state === "incompatible")
      log.warn("plugin.unavailable", { plugin: p.id, state: p.state, reason: p.reason });
  const installer = new PluginInstaller({ kernel, state, discovery, db: options.db, log });
  return {
    kernel,
    contributions,
    installer,
    services,
    discovery,
    state,
    exportsOf,
    stop: () => kernel.stop(),
  };
}
