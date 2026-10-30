// The kernel side of an external plugin (design D6): starts plugin-runner.mjs under Node's permission model and
// turns it into a PluginModule. The plugin's `rh` calls arrive as messages and run against the kernel's rh API for
// that plugin (so every permission check applies); functions cross the boundary as handles both ways. A crash, or a
// call the plugin does not answer within the time limit, marks the plugin failed without touching anything else.
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "../logger.ts";
import { PLUGIN_RUNNER as RUNNER } from "../paths.ts";
import type { RhApi } from "./api.ts";
import type { PluginContext, PluginModule } from "./lifecycle.ts";
import type { DiscoveredPlugin } from "./registry.ts";

/** Every rh function a plugin process may call (paths into RhApi). */
export const RH_PATHS = [
  "db.table",
  "db.migrate",
  "db.run",
  "db.all",
  "db.get",
  "files.read",
  "files.write",
  "files.list",
  "files.exists",
  "http.json",
  "http.text",
  "secrets.get",
  "models.complete",
  "embeddings.embed",
  "decisions.decide",
  "agents.registerChatTool",
  "commands.register",
  "commands.execute",
  "scheduler.register",
  "events.on",
  "events.emit",
  "processes.start",
  "ui.notify",
  "proposals.submit",
] as const;

type Fn = (...args: unknown[]) => unknown;

/** A plugin process's output lines, as log events. */
function forwardTo(log: Logger, level: "info" | "warn") {
  return (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean))
      log[level]("plugin.output", { line: line.slice(0, 500) });
  };
}

export interface ExternalOptions {
  log: Logger;
  /** Called when the process dies or hangs while the plugin is active. */
  onFailure(pluginId: string, reason: string): void | Promise<void>;
  /** Longest wait for an answer from the plugin process (default 30 s). */
  callTimeoutMs?: number;
}

interface Message {
  t: string;
  id: number;
  fn: number | string;
  args: unknown[];
  value?: unknown;
  error?: { name: string; message: string };
}

/** One external plugin's process and the calls in flight both ways; functions travel as numbered handles. */
class PluginProcess {
  private readonly id: string;
  private readonly log: Logger;
  private child?: ChildProcess;
  private stopping = false;
  private readonly local = new Map<number, Fn>();
  private nextHandle = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextCall = 1;
  private named: Record<string, Fn> = {};

  constructor(
    private readonly plugin: DiscoveredPlugin,
    private readonly options: ExternalOptions,
  ) {
    this.id = plugin.manifest.id;
    this.log = options.log.child({ plugin: this.id });
  }

  private encode(value: unknown): unknown {
    if (typeof value === "function") {
      const handle = this.nextHandle++;
      this.local.set(handle, value as Fn);
      return { $fn: handle };
    }
    if (Array.isArray(value)) return value.map((v) => this.encode(v));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      // Error objects and class instances travel as their plain fields.
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.encode(v)]));
    }
    return value;
  }

  private decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.decode(v));
    if (value && typeof value === "object") {
      const handle = (value as { $fn?: unknown }).$fn;
      if (typeof handle === "number") return (...args: unknown[]) => this.call(handle, args);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.decode(v)]));
    }
    return value;
  }

  /** The process died or hung: stop it, let the kernel mark the plugin failed, then reject what was waiting. */
  private async fail(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.warn("plugin.process_failed", { reason });
    this.child?.kill("SIGKILL");
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) clearTimeout(p.timer);
    try {
      await this.options.onFailure(this.id, reason);
    } finally {
      for (const p of waiting) p.reject(new Error(`${this.id}: ${reason}`));
    }
  }

  private call(target: number | string, args: unknown[]): Promise<unknown> {
    if (this.stopping || !this.child?.connected) return Promise.reject(new Error(`${this.id} is not running`));
    const callId = this.nextCall++;
    const timeoutMs = this.options.callTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => void this.fail(`did not answer within ${timeoutMs / 1000} s`), timeoutMs);
      timer.unref?.();
      this.pending.set(callId, { resolve, reject, timer });
      this.child!.send({ t: "call", id: callId, fn: target, args: this.encode(args) });
    });
  }

  private reply(message: Message): void {
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
    else waiting.resolve(this.decode(message.value));
  }

  /** A call from the plugin: to a function handle it was given, or to a named rh API function. */
  private async answer(message: Message): Promise<void> {
    const handler = typeof message.fn === "number" ? this.local.get(message.fn) : this.named[message.fn];
    try {
      if (!handler) throw new Error(`${this.id} may not call ${message.fn}`);
      const value = await handler(...(this.decode(message.args) as unknown[]));
      this.child?.send({ t: "reply", id: message.id, value: this.encode(value) });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.child?.send({ t: "reply", id: message.id, error: { name: failure.name, message: failure.message } });
    }
  }

  private onMessage(message: Message): void {
    if (message.t === "reply") this.reply(message);
    else if (message.t === "call") void this.answer(message);
  }

  /** Fork the runner with Node's permission model: it reads only its own code and storage, writes only storage. */
  private start(context: PluginContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const storage = context.storageDir;
      const child = fork(RUNNER, [], {
        execArgv: [
          "--permission",
          `--allow-fs-read=${RUNNER}`,
          `--allow-fs-read=${this.plugin.dir}`,
          `--allow-fs-read=${storage}`,
          `--allow-fs-write=${storage}`,
        ],
        cwd: storage,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      });
      this.child = child;
      child.stdout?.on("data", forwardTo(this.log, "info"));
      child.stderr?.on("data", forwardTo(this.log, "warn"));
      child.on("message", (m) => this.onMessage(m as Message));
      child.once("message", (m) => ((m as { t: string }).t === "ready" ? resolve() : undefined));
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (!this.stopping) void this.fail(`the plugin process exited (${signal ?? `code ${code}`})`);
        reject(new Error(`${this.id}: the plugin process exited before it was ready`));
      });
    });
  }

  /** What the plugin may call by name: a few context functions and the rh API paths. */
  private nameTargets(context: PluginContext): void {
    const rh = context.rh as RhApi;
    this.named = {
      "ctx.onSettingsChange": (handler) => context.onSettingsChange(handler as never),
      "ctx.log": (level, event, fields) => this.log[level === "warn" ? "warn" : "info"](String(event), fields as never),
    };
    for (const path of RH_PATHS) {
      const [ns, name] = path.split(".") as [keyof RhApi, string];
      const target = (rh[ns] as unknown as Record<string, Fn>)[name];
      this.named[`rh.${path}`] = (...args) => target.apply(rh[ns], args);
    }
  }

  async activate(context: PluginContext): Promise<unknown> {
    this.stopping = false;
    // First in, last out: the process stops after everything else the plugin registered is disposed.
    context.subscriptions.push({
      dispose: () => {
        this.stopping = true;
        this.child?.kill("SIGTERM");
      },
    });
    this.nameTargets(context);
    await this.start(context);
    const { plugin } = this;
    return this.call("activate", [
      {
        id: this.id,
        manifest: plugin.manifest,
        dir: plugin.dir,
        storageDir: context.storageDir,
        settings: context.settings,
        main: join(plugin.dir, plugin.manifest.main ?? "main.mjs"),
        rhPaths: RH_PATHS,
      },
    ]);
  }

  async deactivate(): Promise<void> {
    if (this.stopping || !this.child?.connected) return;
    await this.call("deactivate", []).catch(() => undefined);
  }
}

export function externalModule(plugin: DiscoveredPlugin, options: ExternalOptions): PluginModule {
  const pluginProcess = new PluginProcess(plugin, options);
  return {
    activate: (context) => pluginProcess.activate(context),
    deactivate: () => pluginProcess.deactivate(),
  };
}
