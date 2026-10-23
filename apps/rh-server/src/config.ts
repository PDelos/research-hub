// Configuration from the environment only. Live mode needs OPENROUTER_API_KEY and fails closed without it;
// offline mode (RH_MODE=offline) uses a faux model and mock Jev and needs no keys at all.
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { jobModelsFromEnv, type Job } from "@rh/durable-agent";
import { jevModelFromEnv } from "@rh/jev";

export type Mode = "live" | "offline";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  /** The one research project this container serves (RH_PROJECT_NAME). */
  projectName: string;
  mode: Mode;
  host: string;
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  /** Guards /v1 for external callers (curl, scripts). */
  apiToken: string;
  /** Held server-side by the UI proxy; never sent to the browser. */
  clientToken: string;
  /** True when a token was generated for this process because none was configured. */
  generatedTokens: string[];
  models: Record<Job, string>;
  jevModel: string;
  openrouterKey?: string;
  promptsDir: string;
  uiDir: string;
  /** Host names (without port) the UI proxy answers (DNS-rebinding guard). */
  allowedHosts: Set<string>;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly variable: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const APP_DIR = resolve(import.meta.dirname, "..");
/** Relative paths in configuration resolve against the repository root, whatever directory npm runs in. */
const REPO_ROOT = resolve(APP_DIR, "../..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const projectName = env.RH_PROJECT_NAME?.trim() || "research";
  if (!PROJECT_NAME.test(projectName))
    throw new ConfigError(
      `RH_PROJECT_NAME must be 1 to 40 lowercase letters, digits or dashes (no leading or trailing dash), got "${env.RH_PROJECT_NAME}"`,
      "RH_PROJECT_NAME",
    );
  const mode = (env.RH_MODE?.trim() || "live") as Mode;
  if (mode !== "live" && mode !== "offline")
    throw new ConfigError(`RH_MODE must be live or offline, got "${env.RH_MODE}"`, "RH_MODE");
  const openrouterKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  if (mode === "live" && !openrouterKey)
    throw new ConfigError(
      "OPENROUTER_API_KEY is required in live mode (or set RH_MODE=offline to run without keys)",
      "OPENROUTER_API_KEY",
    );
  const port = Number(env.RH_PORT?.trim() || 4850);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError(`RH_PORT must be a port number, got "${env.RH_PORT}"`, "RH_PORT");
  const level = (env.RH_LOG_LEVEL?.trim() || "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(level))
    throw new ConfigError(`RH_LOG_LEVEL must be debug, info, warn or error`, "RH_LOG_LEVEL");
  const generatedTokens: string[] = [];
  const token = (name: string) => {
    const value = env[name]?.trim();
    if (value) return value;
    generatedTokens.push(name);
    return randomBytes(24).toString("hex");
  };
  const host = env.RH_HOST?.trim() || "127.0.0.1";
  const allowedHosts = new Set<string>();
  for (const h of [
    "localhost",
    "127.0.0.1",
    `${projectName}.localhost`,
    host,
    ...(env.RH_ALLOWED_HOSTS ?? "").split(","),
  ]) {
    const name = h.trim().toLowerCase();
    if (!name || name === "0.0.0.0") continue;
    allowedHosts.add(name);
  }
  return {
    projectName,
    mode,
    host,
    port,
    dataDir: resolve(REPO_ROOT, env.RH_DATA_DIR?.trim() || "./data"),
    logLevel: level,
    apiToken: token("RH_API_TOKEN"),
    clientToken: token("RH_CLIENT_TOKEN"),
    generatedTokens,
    models: jobModelsFromEnv(env),
    jevModel: jevModelFromEnv(env),
    openrouterKey,
    promptsDir: join(APP_DIR, "prompt_engineering"),
    uiDir: resolve(REPO_ROOT, env.RH_UI_DIR?.trim() || "apps/rh-client-browser/dist"),
    allowedHosts,
  };
}

/** Values that must never appear in logs or responses. */
export function secretsOf(config: Config): string[] {
  return [config.openrouterKey, config.apiToken, config.clientToken].filter(
    (s): s is string => !!s && s.length >= 8,
  );
}
