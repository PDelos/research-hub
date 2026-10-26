// Supervised plugin processes (spec plugin-system: Declarative contributions; design D2, D6), generalized from v0's
// viewer supervisor: a Node child bound to 127.0.0.1 (loopback preload) on a free port given in PORT, with a clean
// environment (no secrets), output forwarded to the log, and restarts after a crash with backoff (2 s doubling to
// 10 s; a process that stayed up a minute starts afresh).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Logger } from "../logger.ts";

const LOOPBACK = join(import.meta.dirname, "..", "kb", "loopback.cjs");

export type ProcessState = "starting" | "running" | "crashed" | "stopped";

export interface SupervisorOptions {
  /** "<plugin id>/<process id>" for logs. */
  name: string;
  entry: string;
  args?: string[];
  cwd: string;
  /** Extra environment (PATH, HOME and PORT are always set; nothing else is inherited). */
  env?: Record<string, string>;
  home: string;
  log: Logger;
  restartDelays?: number[];
  /** Wait until GET http://127.0.0.1:<port>/ answers (default true). */
  http?: boolean;
  readyTimeoutMs?: number;
}

export class Supervisor {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private healthySince = 0;
  restarts = 0;
  state: ProcessState = "stopped";
  port?: number;

  constructor(private readonly options: SupervisorOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    const o = this.options;
    this.port ??= await freePort();
    this.state = "starting";
    const child = spawn(process.execPath, ["--require", LOOPBACK, o.entry, ...(o.args ?? [])], {
      cwd: o.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: o.home, PORT: String(this.port), ...o.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const forward = (level: "info" | "warn") => (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean))
        o.log[level]("plugin.process_output", { process: o.name, line: line.slice(0, 500) });
    };
    child.stdout?.on("data", forward("info"));
    child.stderr?.on("data", forward("warn"));
    child.once("exit", (code, signal) => this.exited(child, code, signal));
    if (o.http === false || (await this.waitReady(o.readyTimeoutMs ?? 30_000))) {
      if (this.child !== child) return;
      this.state = "running";
      this.healthySince = Date.now();
      o.log.info("plugin.process_running", { process: o.name, port: this.port });
    } else if (this.child === child) {
      o.log.warn("plugin.process_not_ready", { process: o.name });
      child.kill("SIGKILL");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.state = "stopped";
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.stopping) return;
    if (Date.now() - this.healthySince > 60_000) this.restarts = 0;
    const delays = this.options.restartDelays ?? [2_000, 4_000, 8_000, 10_000];
    const delay = delays[Math.min(this.restarts, delays.length - 1)];
    this.restarts++;
    this.state = "crashed";
    this.options.log.warn("plugin.process_crashed", { process: this.options.name, code, signal, restartInMs: delay });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.start();
    }, delay);
    this.timer.unref?.();
  }

  private async waitReady(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && this.child && this.child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1_000) });
        await res.body?.cancel();
        if (res.status < 500) return true;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
