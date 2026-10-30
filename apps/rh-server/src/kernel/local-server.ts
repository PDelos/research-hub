// A local helper server a plugin starts on first use and supervises (Docling Serve, the local embedder): one start
// at a time, ready when GET /health answers, restarted on the next use after it exits, killed on dispose.
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../logger.ts";

export interface LocalServerOptions {
  /** Where the server listens (http://127.0.0.1:<port>). */
  base: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** What the log and errors call it ("docling-serve", "the embedding server"). */
  name: string;
  /** Log event prefix ("docling", "local_embed"). */
  event: string;
  startTimeoutMs: number;
  log: Logger;
}

export class LocalServer {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private stopped = false;
  /** How often the server exited after starting; callers back off and give up on a flapping server. */
  restarts = 0;

  constructor(private readonly options: LocalServerOptions) {}

  async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${this.options.base}/health`, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
      return false;
    }
  }

  /** Start the server unless it already answers; resolves once it is healthy. */
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.starting ??= this.launch();
    return this.starting;
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill("SIGTERM");
  }

  private async launch(): Promise<void> {
    if (await this.healthy()) return;
    const { command, args, env, name, event, log } = this.options;
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], ...(env ? { env } : {}) });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-2_000)));
    child.on("exit", (code) => {
      this.child = undefined;
      this.starting = undefined;
      if (this.stopped) return;
      log.warn(`${event}.exited`, { code, stderr: stderr.slice(-500) });
      this.restarts++;
    });
    const deadline = Date.now() + this.options.startTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(`${name} exited while starting: ${stderr.slice(-300)}`);
      if (await this.healthy()) {
        log.info(`${event}.started`, { base: this.options.base });
        return;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`${name} did not start within ${Math.round(this.options.startTimeoutMs / 60_000)} minutes`);
  }
}
