// The `rh` kernel API, version 1.0.0 (spec plugin-system: Kernel API versioning, Permissions; design D2): what a
// plugin's `activate(context)` receives as `context.rh`. Every call is checked against the plugin's declared
// permissions (hosts, files, secrets, budget, its own tables); refusals are logged with the plugin id. Models,
// embeddings and decisions go through the active provider plugins; their cost counts against the plugin's budget.
// Everything a plugin registers is disposed when it is deactivated.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import { PoliteHttp, type RequestOptions } from "../papers/http.ts";
import type { ContributionRegistry } from "./contributions.ts";
import type { Disposable } from "./lifecycle.ts";
import { KERNEL_API_VERSION } from "./manifest.ts";
import { Budgets, Guard } from "./permissions.ts";
import { Supervisor } from "./processes.ts";
import type { DiscoveredPlugin } from "./registry.ts";

export const RH_API_VERSION = KERNEL_API_VERSION;

// ---------------------------------------------------------------- services the kernel provides

export interface ModelRequest {
  /** A job name the provider maps to a configured model (e.g. "chat", "summary"), or an explicit model id. */
  job?: string;
  model?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}
export interface ModelsService {
  complete(request: ModelRequest): Promise<{ text: string; model: string; costUsd: number }>;
}
export interface EmbeddingsService {
  embed(
    texts: string[],
    options?: { model?: string },
  ): Promise<{ vectors: number[][]; model: string; costUsd: number }>;
}
export interface DecisionsService {
  /** Run a versioned Jev command contributed by an enabled plugin. */
  decide(
    command: string,
    vars: Record<string, unknown>,
  ): Promise<{ answers: Record<string, unknown>; costUsd: number }>;
}
export interface AgentsService {
  /** Register an agent definition (prompt folder, tools); used by the desk and the agents plugins. */
  register(pluginId: string, agent: { name: string; promptDir: string; tools?: string[] }): Disposable;
}

/** Events plugins exchange through `rh.events` (payloads are plain JSON). */
export interface EventMap {
  "paper.stored": { paperId: number };
  "card.created": { cardId: number; sweepId: number };
  "judgment.changed": { cardId: number; verdict: string | null };
  "kb.noteWritten": { path: string };
  "sweep.finished": { sweepId: number; status: string };
  "budget.exceeded": { pluginId: string; limitUsd: number };
  "ui.notify": { pluginId: string; message: string; level: "info" | "warning" };
  [custom: `${string}.${string}`]: unknown;
}

export class EventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  constructor(private readonly log: Logger) {}

  on<K extends keyof EventMap & string>(type: K, handler: (payload: EventMap[K]) => void): Disposable {
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    const listener = handler as (payload: unknown) => void;
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  }

  emit<K extends keyof EventMap & string>(type: K, payload: EventMap[K]): void {
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        this.log.warn("events.handler_failed", { type, error: String(error) });
      }
    }
  }
}

/** Scheduled work plugins register by kind; the kernel's scheduler runs it (firing onSchedule:<kind> first). */
export class ScheduleRegistry {
  private readonly handlers = new Map<string, { pluginId: string; run: () => Promise<void> | void }>();

  register(pluginId: string, kind: string, run: () => Promise<void> | void): Disposable {
    this.handlers.set(kind, { pluginId, run });
    return { dispose: () => void (this.handlers.get(kind)?.run === run && this.handlers.delete(kind)) };
  }

  kinds(): { kind: string; pluginId: string }[] {
    return [...this.handlers].map(([kind, h]) => ({ kind, pluginId: h.pluginId }));
  }

  get(kind: string) {
    return this.handlers.get(kind);
  }
}

export interface KernelServices {
  db: Db;
  vaultDir: string;
  /** data/plugins/data: each plugin's storage folder is <storageRoot>/<id>. */
  storageRoot: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
  events: EventBus;
  budgets: Budgets;
  contributions: ContributionRegistry;
  schedules: ScheduleRegistry;
  fetch?: typeof fetch;
  /** The active providers (set by the provider and decision plugins); undefined until one is active. */
  providers: {
    models?: ModelsService;
    embeddings?: EmbeddingsService;
    decisions?: DecisionsService;
    agents?: AgentsService;
  };
}

// ---------------------------------------------------------------- the API

export type FileScope = "storage" | "plugin" | "vault";
export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RhApi {
  readonly version: string;
  readonly pluginId: string;
  readonly log: Logger;
  db: {
    /** The plugin's table name for `name` (p_<plugin>__<name>); its migrations may only create such tables. */
    table(name: string): string;
    /** Apply the plugin's numbered migrations once each (recorded in plugin_migrations). */
    migrate(migrations: { version: number; sql: string }[]): number;
    /** Built-ins only in practice (statements do not cross a process boundary). */
    prepare(sql: string): ReturnType<Db["prepare"]>;
    /** Run a statement on the plugin's own tables. */
    run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number };
    all(sql: string, ...params: SqlParam[]): Record<string, unknown>[];
    get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined;
  };
  files: {
    read(scope: FileScope, path: string): string;
    write(scope: FileScope, path: string, content: string): void;
    list(scope: FileScope, path?: string): string[];
    exists(scope: FileScope, path: string): boolean;
  };
  http: {
    /** A paced, retried request to a declared host; `costUsd` (e.g. a paid search) counts against the budget. */
    request(url: string, options?: Partial<RequestOptions> & { costUsd?: number }): Promise<Response>;
    json<T>(url: string, options?: Partial<RequestOptions> & { costUsd?: number }): Promise<T>;
    text(url: string, options?: Partial<RequestOptions> & { costUsd?: number }): Promise<string>;
  };
  secrets: { get(name: string): string | undefined };
  models: ModelsService;
  embeddings: EmbeddingsService;
  decisions: DecisionsService;
  agents: {
    register(agent: { name: string; promptDir: string; tools?: string[] }): Disposable;
    registerChatTool(name: string, handler: (args: unknown) => unknown): Disposable;
  };
  commands: {
    register(id: string, handler: (args: unknown) => unknown): Disposable;
    execute(id: string, args?: unknown): Promise<unknown>;
  };
  scheduler: { register(kind: string, run: () => Promise<void> | void): Disposable };
  events: {
    on<K extends keyof EventMap & string>(type: K, handler: (payload: EventMap[K]) => void): Disposable;
    emit<K extends keyof EventMap & string>(type: K, payload: EventMap[K]): void;
  };
  processes: {
    /** Start a process declared under contributes.processes; stopped when the plugin is deactivated. */
    start(
      id: string,
      options?: { args?: string[]; env?: Record<string, string>; http?: boolean },
    ): Promise<{ port: number; stop(): Promise<void> }>;
  };
  ui: { notify(message: string, level?: "info" | "warning"): void };
  proposals: { submit(proposal: unknown): never };
}

/** A plugin's table prefix: p_<id with non-alphanumerics as _>__. */
export function tablePrefix(pluginId: string): string {
  return `p_${pluginId.replace(/[^a-z0-9]/g, "_")}__`;
}

const CREATES =
  /\bCREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)/gi;
const TOUCHES =
  /\b(?:ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)(?:\s+IF\s+EXISTS)?|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?([A-Za-z0-9_]+)/gi;
const READS = /\b(?:FROM|JOIN)\s+["`]?([A-Za-z0-9_]+)/gi;

export function createRhApi(plugin: DiscoveredPlugin, services: KernelServices, subscriptions: Disposable[]): RhApi {
  const { manifest } = plugin;
  const id = manifest.id;
  const log = services.log.child({ plugin: id });
  const guard = new Guard(manifest, services.log);
  const prefix = tablePrefix(id);
  const storageDir = join(services.storageRoot, id);
  const http = new PoliteHttp({ ...(services.fetch ? { fetch: services.fetch } : {}), log });
  const limit = manifest.permissions.budgetUsdPerDay;
  const track = <T>(subscription: T & Disposable): T => {
    subscriptions.push(subscription);
    return subscription;
  };

  const roots: Record<FileScope, string> = { storage: storageDir, plugin: plugin.dir, vault: services.vaultDir };
  const file = (scope: FileScope, path: string, write: boolean): string => {
    if (scope === "vault") guard.vault(write);
    else if (scope === "plugin" && write)
      guard.deny("files", `plugin:${path}`, `${id} may not change its own installed files`);
    else if (!(scope in roots)) guard.deny("files", `${scope}:${path}`, `${id} used an unknown file scope ${scope}`);
    const root = resolvePath(roots[scope]);
    const full = resolvePath(root, path);
    if (full !== root && !full.startsWith(root + sep))
      guard.deny("files", `${scope}:${path}`, `${id} may not reach ${path} outside its ${scope} folder`);
    return full;
  };

  /** Statements a plugin runs through rh.db may only read and change its own tables. */
  const ownTables = (sql: string) => {
    for (const re of [CREATES, TOUCHES, READS])
      for (const match of sql.matchAll(re))
        if (!match[1].startsWith(prefix))
          guard.deny("db", match[1], `${id} may only use its own tables (${prefix}*), not ${match[1]}`);
  };

  const paid = async <T extends { costUsd: number }>(call: () => Promise<T>): Promise<T> => {
    services.budgets.assertWithin(id, limit);
    const result = await call();
    services.budgets.charge(id, result.costUsd);
    return result;
  };
  const provider = <K extends keyof KernelServices["providers"]>(
    kind: K,
    what: string,
  ): NonNullable<KernelServices["providers"][K]> => {
    const provider = services.providers[kind];
    if (!provider) throw new Error(`no ${what} plugin is active`);
    return provider as NonNullable<KernelServices["providers"][K]>;
  };

  return {
    version: RH_API_VERSION,
    pluginId: id,
    log,
    db: {
      table: (name) => `${prefix}${name}`,
      migrate(migrations) {
        const db = services.db;
        db.exec(
          "CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (plugin_id, version))",
        );
        const done = new Set(
          (
            db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = ?").all(id) as { version: number }[]
          ).map((r) => Number(r.version)),
        );
        let applied = 0;
        for (const m of migrations.toSorted((a, b) => a.version - b.version)) {
          if (done.has(m.version)) continue;
          for (const re of [CREATES, TOUCHES])
            for (const match of m.sql.matchAll(re))
              if (!match[1].startsWith(prefix))
                guard.deny(
                  "db",
                  match[1],
                  `${id} may only create and change its own tables (${prefix}*), not ${match[1]}`,
                );
          db.exec("BEGIN");
          try {
            db.exec(m.sql);
            db.prepare("INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES (?, ?, ?)").run(
              id,
              m.version,
              new Date().toISOString(),
            );
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          applied++;
        }
        return applied;
      },
      prepare: (sql) => services.db.prepare(sql),
      run(sql, ...params) {
        ownTables(sql);
        const written = services.db.prepare(sql).run(...params);
        return { changes: Number(written.changes), lastInsertRowid: Number(written.lastInsertRowid) };
      },
      all(sql, ...params) {
        ownTables(sql);
        return services.db.prepare(sql).all(...params) as Record<string, unknown>[];
      },
      get(sql, ...params) {
        ownTables(sql);
        return services.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      },
    },
    files: {
      read: (scope, path) => readFileSync(file(scope, path, false), "utf8"),
      write(scope, path, content) {
        const full = file(scope, path, true);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      },
      list(scope, path = ".") {
        const full = file(scope, path, false);
        return existsSync(full) ? readdirSync(full).toSorted() : [];
      },
      exists: (scope, path) => existsSync(file(scope, path, false)),
    },
    http: {
      async request(url, options = {}) {
        guard.host(url);
        const { costUsd, ...rest } = options;
        if (costUsd) services.budgets.assertWithin(id, limit);
        const response = await http.request(url, { source: id, ...rest });
        if (costUsd) services.budgets.charge(id, costUsd);
        return response;
      },
      async json<T>(url: string, options: Partial<RequestOptions> & { costUsd?: number } = {}) {
        const response = await this.request(url, {
          ...options,
          headers: { accept: "application/json", ...options.headers },
        });
        return (await response.json()) as T;
      },
      async text(url, options = {}) {
        return (await this.request(url, options)).text();
      },
    },
    secrets: {
      get(name) {
        guard.secret(name);
        return services.env[name];
      },
    },
    models: { complete: (request) => paid(() => provider("models", "model provider").complete(request)) },
    embeddings: { embed: (texts, options) => paid(() => provider("embeddings", "embedder").embed(texts, options)) },
    decisions: {
      decide: (command, vars) => paid(() => provider("decisions", "decision engine").decide(command, vars)),
    },
    agents: {
      register: (agent) => track(provider("agents", "agent runtime").register(id, agent)),
      registerChatTool: (name, handler) => track(services.contributions.registerChatTool(id, name, handler)),
    },
    commands: {
      register: (commandId, handler) => track(services.contributions.registerCommand(id, commandId, handler)),
      execute: (commandId, args) => services.contributions.executeCommand(commandId, args),
    },
    scheduler: { register: (kind, run) => track(services.schedules.register(id, kind, run)) },
    events: {
      on: (type, handler) => track(services.events.on(type, handler)),
      emit: (type, payload) => services.events.emit(type, payload),
    },
    processes: {
      async start(processId, options = {}) {
        const declared = services.contributions.processes(id).find((p) => p.id === processId);
        if (!declared) throw new Error(`${id} did not declare the process ${processId} in contributes.processes`);
        const entry = file("plugin", declared.entry, false);
        mkdirSync(storageDir, { recursive: true });
        const supervisor = new Supervisor({
          name: `${id}/${processId}`,
          entry,
          args: [...(declared.args ?? []), ...(options.args ?? [])],
          cwd: plugin.dir,
          home: storageDir,
          env: options.env ?? {},
          log,
          ...(options.http === undefined ? {} : { http: options.http }),
        });
        track({ dispose: () => supervisor.stop() });
        await supervisor.start();
        return { port: supervisor.port!, stop: () => supervisor.stop() };
      },
    },
    ui: { notify: (message, level = "info") => services.events.emit("ui.notify", { pluginId: id, message, level }) },
    proposals: {
      submit() {
        throw new Error("proposals arrive with the Upgrades tab (v1-4)");
      },
    },
  };
}
