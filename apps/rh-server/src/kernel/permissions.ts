// Permissions (spec plugin-system: Permissions; design D2): a plugin reaches only the network hosts, files, secrets
// and daily budget it declares. Every refusal is logged with the plugin id and kept for the Plugins view; the first
// call over budget on a day notifies the user once.
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { PluginManifest } from "./manifest.ts";

export type PermissionKind = "network" | "files" | "secrets" | "db";

export class PermissionDenied extends Error {
  constructor(
    readonly pluginId: string,
    readonly kind: PermissionKind,
    readonly target: string,
    message: string,
  ) {
    super(message);
    this.name = "PermissionDenied";
  }
}

export class BudgetExceeded extends Error {
  constructor(
    readonly pluginId: string,
    readonly limitUsd: number,
    readonly spentUsd: number,
  ) {
    super(
      `${pluginId} reached its budget of $${limitUsd.toFixed(2)} for today ($${spentUsd.toFixed(4)} spent); it resets at midnight UTC`,
    );
    this.name = "BudgetExceeded";
  }
}

/** Exact host names, or "*.example.org" for any subdomain of example.org. */
export function hostAllowed(patterns: readonly string[], host: string): boolean {
  const lowerHost = host.toLowerCase();
  return patterns.some((p) =>
    p.startsWith("*.")
      ? lowerHost.endsWith(p.slice(1)) && lowerHost.length > p.length - 1
      : lowerHost === p.toLowerCase(),
  );
}

export interface Denial {
  time: string;
  kind: PermissionKind;
  target: string;
  message: string;
}

/** Checks one plugin's declared permissions; refusals are logged and remembered (last 50). */
export class Guard {
  readonly denials: Denial[] = [];

  constructor(
    private readonly manifest: PluginManifest,
    private readonly log: Logger,
  ) {}

  get id(): string {
    return this.manifest.id;
  }

  deny(kind: PermissionKind, target: string, message: string): never {
    this.log.warn("plugin.permission_denied", { plugin: this.manifest.id, kind, target });
    this.denials.push({ time: new Date().toISOString(), kind, target, message });
    if (this.denials.length > 50) this.denials.shift();
    throw new PermissionDenied(this.manifest.id, kind, target, message);
  }

  host(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return this.deny("network", url, `${this.manifest.id} requested an invalid URL: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      this.deny("network", url, `${this.manifest.id} may only use http(s), not ${parsed.protocol}`);
    if (!hostAllowed(this.manifest.permissions.network ?? [], parsed.hostname))
      this.deny("network", parsed.hostname, `${this.manifest.id} may not reach ${parsed.hostname}`);
    return parsed;
  }

  vault(write: boolean): void {
    const files = this.manifest.permissions.files ?? [];
    if (files.includes("vault:read-write") || (!write && files.includes("vault:read"))) return;
    this.deny("files", "vault", `${this.manifest.id} may not ${write ? "write" : "read"} vault files`);
  }

  secret(name: string): void {
    if (!(this.manifest.permissions.secrets ?? []).includes(name))
      this.deny("secrets", name, `${this.manifest.id} may not read the secret ${name}`);
  }
}

/** Per-plugin spending per UTC day against `permissions.budgetUsdPerDay`. */
export class Budgets {
  constructor(
    private readonly db: Db,
    private readonly options: { now?: () => Date; onExceeded?: (pluginId: string, limitUsd: number) => void } = {},
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_spend (
      plugin_id TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (plugin_id, day))`);
  }

  private day(): string {
    return (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  spent(pluginId: string): number {
    const row = this.db
      .prepare("SELECT usd FROM plugin_spend WHERE plugin_id = ? AND day = ?")
      .get(pluginId, this.day()) as { usd: number } | undefined;
    return row?.usd ?? 0;
  }

  /** Throw BudgetExceeded when today's spending has reached the limit (notifying once per day). No limit: no check. */
  assertWithin(pluginId: string, limitUsd: number | undefined): void {
    if (limitUsd === undefined) return;
    const spent = this.spent(pluginId);
    if (spent < limitUsd) return;
    const day = this.day();
    this.db
      .prepare("INSERT INTO plugin_spend (plugin_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(pluginId, day);
    const first = this.db
      .prepare("UPDATE plugin_spend SET notified = 1 WHERE plugin_id = ? AND day = ? AND notified = 0")
      .run(pluginId, day);
    if (Number(first.changes) > 0) this.options.onExceeded?.(pluginId, limitUsd);
    throw new BudgetExceeded(pluginId, limitUsd, spent);
  }

  charge(pluginId: string, usd: number): void {
    this.db
      .prepare(
        "INSERT INTO plugin_spend (plugin_id, day, usd, calls) VALUES (?, ?, ?, 1) ON CONFLICT (plugin_id, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1",
      )
      .run(pluginId, this.day(), Math.max(0, usd));
  }
}
