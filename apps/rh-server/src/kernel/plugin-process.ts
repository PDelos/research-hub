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

export function externalModule(plugin: DiscoveredPlugin, options: ExternalOptions): PluginModule {
  const id = plugin.manifest.id;
  const log = options.log.child({ plugin: id });
  let child: ChildProcess | undefined;
  let stopping = false;
  const local = new Map<number, Fn>();
  let nextHandle = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextCall = 1;
  let named: Record<string, Fn> = {};

  const encode = (value: unknown): unknown => {
    if (typeof value === "function") {
      const handle = nextHandle++;
      local.set(handle, value as Fn);
      return { $fn: handle };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      // Error objects and class instances travel as their plain fields.
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
    }
    return value;
  };
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object") {
      const handle = (value as { $fn?: unknown }).$fn;
      if (typeof handle === "number") return (...args: unknown[]) => call(handle, args);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
    }
    return value;
  };

  /** The process died or hung: stop it, let the kernel mark the plugin failed, then reject what was waiting. */
  const fail = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.warn("plugin.process_failed", { reason });
    child?.kill("SIGKILL");
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) clearTimeout(p.timer);
    try {
      await options.onFailure(id, reason);
    } finally {
      for (const p of waiting) p.reject(new Error(`${id}: ${reason}`));
    }
  };

  const call = (fn: number | string, args: unknown[]): Promise<unknown> => {
    if (stopping || !child?.connected) return Promise.reject(new Error(`${id} is not running`));
    const callId = nextCall++;
    const timeoutMs = options.callTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => void fail(`did not answer within ${timeoutMs / 1000} s`), timeoutMs);
      timer.unref?.();
      pending.set(callId, { resolve, reject, timer });
      child!.send({ t: "call", id: callId, fn, args: encode(args) });
    });
  };

  const onMessage = async (message: {
    t: string;
    id: number;
    fn: number | string;
    args: unknown[];
    value?: unknown;
    error?: { name: string; message: string };
  }) => {
    if (message.t === "reply") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
      else waiting.resolve(decode(message.value));
      return;
    }
    if (message.t !== "call") return;
    const fn = typeof message.fn === "number" ? local.get(message.fn) : named[message.fn];
    try {
      if (!fn) throw new Error(`${id} may not call ${message.fn}`);
      const value = await fn(...(decode(message.args) as unknown[]));
      child?.send({ t: "reply", id: message.id, value: encode(value) });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      child?.send({ t: "reply", id: message.id, error: { name: e.name, message: e.message } });
    }
  };

  const start = (context: PluginContext) =>
    new Promise<void>((resolve, reject) => {
      const storage = context.storageDir;
      child = fork(RUNNER, [], {
        execArgv: [
          "--permission",
          `--allow-fs-read=${RUNNER}`,
          `--allow-fs-read=${plugin.dir}`,
          `--allow-fs-read=${storage}`,
          `--allow-fs-write=${storage}`,
        ],
        cwd: storage,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      });
      child.stdout?.on("data", forwardTo(log, "info"));
      child.stderr?.on("data", forwardTo(log, "warn"));
      child.on("message", (m) => void onMessage(m as never));
      child.once("message", (m) => ((m as { t: string }).t === "ready" ? resolve() : undefined));
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (!stopping) void fail(`the plugin process exited (${signal ?? `code ${code}`})`);
        reject(new Error(`${id}: the plugin process exited before it was ready`));
      });
    });

  return {
    async activate(context) {
      stopping = false;
      // First in, last out: the process stops after everything else the plugin registered is disposed.
      context.subscriptions.push({
        dispose: () => {
          stopping = true;
          child?.kill("SIGTERM");
        },
      });
      const rh = context.rh as RhApi;
      named = {
        "ctx.onSettingsChange": (handler) => context.onSettingsChange(handler as never),
        "ctx.log": (level, event, fields) => log[level === "warn" ? "warn" : "info"](String(event), fields as never),
      };
      for (const path of RH_PATHS) {
        const [ns, name] = path.split(".") as [keyof RhApi, string];
        const target = (rh[ns] as unknown as Record<string, Fn>)[name];
        named[`rh.${path}`] = (...args) => target.apply(rh[ns], args);
      }
      await start(context);
      return call("activate", [
        {
          id,
          manifest: plugin.manifest,
          dir: plugin.dir,
          storageDir: context.storageDir,
          settings: context.settings,
          main: join(plugin.dir, plugin.manifest.main ?? "main.mjs"),
          rhPaths: RH_PATHS,
        },
      ]);
    },
    async deactivate() {
      if (stopping || !child?.connected) return;
      await call("deactivate", []).catch(() => undefined);
    },
  };
}
