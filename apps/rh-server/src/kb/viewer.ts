// The knowledge-base viewer (spec knowledge-viewer; design D6): Ignis, the real Obsidian UI as a web app, run as a
// supervised child process inside the project's container. It listens on 127.0.0.1 only (loopback preload) and is
// reached solely through the hub's same-origin proxy. On first start the pinned Obsidian package is downloaded
// from Obsidian's official release (never in offline mode). Crashes restart after 2 s, backing off to 10 s.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Logger } from "../logger.ts";

export type ViewerState = "disabled" | "unavailable" | "starting" | "running" | "crashed";

export interface ViewerStatus {
  state: ViewerState;
  reason?: string;
  ignisVersion?: string;
  obsidianVersion: string;
  restarts: number;
}

export interface KbViewerOptions {
  enabled: boolean;
  /** Ignis checkout or image copy (contains apps/ignis-server/server/index.js). */
  ignisDir: string;
  /** $RH_DATA_DIR/kb-viewer: Ignis data, the Obsidian package, the vaults folder. */
  stateDir: string;
  vaultDir: string;
  projectName: string;
  obsidianVersion: string;
  offline: boolean;
  log: Logger;
  fetch?: typeof fetch;
  /** Restart delays (ms); default 2 s doubling to 10 s. */
  restartDelays?: number[];
  readyTimeoutMs?: number;
}

const LOOPBACK = join(import.meta.dirname, "loopback.cjs");

export class KbViewer {
  private child?: ChildProcess;
  private port?: number;
  private state: ViewerState;
  private reason?: string;
  private restarts = 0;
  private stopping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private healthySince = 0;

  constructor(private readonly options: KbViewerOptions) {
    this.state = options.enabled ? "unavailable" : "disabled";
    this.reason = options.enabled ? "not started yet" : "RH_KB_VIEWER=off";
  }

  status(): ViewerStatus {
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.ignisVersion() ? { ignisVersion: this.ignisVersion() } : {}),
      obsidianVersion: this.options.obsidianVersion,
      restarts: this.restarts,
    };
  }

  /** The viewer's loopback address while it runs. */
  target(): { host: string; port: number } | undefined {
    return this.state === "running" && this.port ? { host: "127.0.0.1", port: this.port } : undefined;
  }

  private ignisVersion(): string | undefined {
    try {
      return JSON.parse(readFileSync(join(this.options.ignisDir, "package.json"), "utf8")).version;
    } catch {
      return undefined;
    }
  }

  /** Start the viewer if it can run (enabled, Ignis present, a vault, Obsidian available). Safe to call again. */
  async start(): Promise<void> {
    const o = this.options;
    if (!o.enabled || this.stopping || this.child || this.state === "starting") return;
    const server = join(o.ignisDir, "apps", "ignis-server", "server", "index.js");
    if (!existsSync(server)) return this.unavailable(`Ignis is not installed at ${o.ignisDir} (set RH_KB_VIEWER_DIR)`);
    if (!existsSync(o.vaultDir)) return this.unavailable("there is no vault yet (approve a charter first)");
    this.state = "starting";
    this.reason = undefined;
    try {
      await this.ensureObsidian();
    } catch (error) {
      return this.unavailable(error instanceof Error ? error.message : String(error));
    }
    this.linkVault();
    this.port = await freePort();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: o.stateDir,
      PORT: String(this.port),
      VAULT_ROOT: join(o.stateDir, "vaults"),
      DATA_ROOT: join(o.stateDir, "data"),
      OBSIDIAN_ASSETS_PATH: join(o.stateDir, "obsidian-app"),
      IGNIS_OBSIDIAN_PIN: o.obsidianVersion,
      NODE_ENV: "production",
    };
    const child = spawn(process.execPath, ["--require", LOOPBACK, server], { cwd: o.ignisDir, env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const forward = (level: "info" | "warn") => (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) o.log[level]("kb.viewer_output", { line: line.slice(0, 500) });
    };
    child.stdout?.on("data", forward("info"));
    child.stderr?.on("data", forward("warn"));
    child.once("exit", (code, signal) => this.exited(child, code, signal));
    if (await this.waitReady(o.readyTimeoutMs ?? 60_000)) {
      if (this.child !== child) return;
      this.state = "running";
      this.healthySince = Date.now();
      o.log.info("kb.viewer_running", { port: this.port, ignis: this.ignisVersion(), obsidian: o.obsidianVersion });
    } else if (this.child === child) {
      o.log.warn("kb.viewer_not_ready", { port: this.port });
      child.kill("SIGKILL");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private unavailable(reason: string): void {
    this.state = "unavailable";
    this.reason = reason;
    this.options.log.warn("kb.viewer_unavailable", { reason });
  }

  private exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.stopping) return;
    // A viewer that stayed up for a minute starts its backoff afresh.
    if (Date.now() - this.healthySince > 60_000) this.restarts = 0;
    const delays = this.options.restartDelays ?? [2_000, 4_000, 8_000, 10_000];
    const delay = delays[Math.min(this.restarts, delays.length - 1)];
    this.restarts++;
    this.state = "crashed";
    this.reason = `exited with ${signal ?? `code ${code}`}; restarting in ${Math.round(delay / 100) / 10} s`;
    this.options.log.warn("kb.viewer_crashed", { code, signal, restartInMs: delay, restarts: this.restarts });
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
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /** Ignis expects one sub-folder per vault: a symlink named after the project points at the vault. */
  private linkVault(): void {
    const vaults = join(this.options.stateDir, "vaults");
    mkdirSync(vaults, { recursive: true });
    mkdirSync(join(this.options.stateDir, "data"), { recursive: true });
    const link = join(vaults, this.options.projectName);
    try {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === this.options.vaultDir) return;
      unlinkSync(link);
    } catch {
      // missing
    }
    symlinkSync(this.options.vaultDir, link, "dir");
  }

  /** Download and unpack the pinned Obsidian package once (official release; never in offline mode). */
  private async ensureObsidian(): Promise<void> {
    const o = this.options;
    const dir = join(o.stateDir, "obsidian-app");
    const stamp = join(dir, ".obsidian-version");
    if (existsSync(join(dir, "index.html")) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === o.obsidianVersion) return;
    if (o.offline) throw new Error(`Obsidian ${o.obsidianVersion} is not downloaded yet, and offline mode makes no downloads`);
    const url = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${o.obsidianVersion}/obsidian-${o.obsidianVersion}.asar.gz`;
    o.log.info("kb.obsidian_download", { url });
    const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`downloading Obsidian ${o.obsidianVersion} failed: HTTP ${res.status}`);
    const asarFile = join(o.stateDir, `obsidian-${o.obsidianVersion}.asar`);
    mkdirSync(o.stateDir, { recursive: true });
    writeFileSync(asarFile, gunzipSync(Buffer.from(await res.arrayBuffer())));
    rmSync(dir, { recursive: true, force: true });
    const { extractAll } = await import("@electron/asar");
    extractAll(asarFile, dir);
    rmSync(asarFile, { force: true });
    if (!existsSync(join(dir, "index.html"))) throw new Error("the Obsidian package did not contain index.html");
    writeFileSync(stamp, o.obsidianVersion);
    o.log.info("kb.obsidian_ready", { version: o.obsidianVersion });
  }
}

function freePort(): Promise<number> {
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
