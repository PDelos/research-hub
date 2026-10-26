// Configuration from the environment only. Live mode needs OPENROUTER_API_KEY and fails closed without it;
// offline mode (RH_MODE=offline) uses a faux model and mock Jev and needs no keys at all.
import { APP_DIR, REPO_ROOT } from "./paths.ts";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { jobModelsFromEnv, type Job } from "@rh/durable-agent";
import { jevModelFromEnv } from "@rh/jev";

export type Mode = "live" | "offline";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ScheduleDefaults {
  timeZone: string;
  sweepTime: string;
  /** The nightly run of the daily cycle (RH_NIGHTLY_TIME, default 02:00). */
  nightlyTime?: string;
  review: { weekday: Weekday; time: string };
}

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
  /** Schedule defaults from RH_TIMEZONE, RH_SWEEP_TIME, RH_REVIEW_TIME; saved settings override them. */
  schedule: ScheduleDefaults;
  /** Host names (without port) the UI proxy answers (DNS-rebinding guard). */
  allowedHosts: Set<string>;
  /** Paper sources and representations (v0.2). */
  papers: PapersConfig;
  /** The embedded Obsidian viewer (v0.5). */
  kbViewer: { enabled: boolean; dir: string; obsidianVersion: string };
}

export interface PapersConfig {
  /** Sent to OpenAlex (mailto) and Europe PMC (email) for their polite pools; warned about once when missing. */
  contactEmail?: string;
  /** The one embedding model for every paper (OpenRouter ID) and its output dimension. */
  embedModel: string;
  embedDims: number;
  /** Semantic Scholar is used only with a key (its keyless pool is rate limited). */
  s2ApiKey?: string;
}

export const DEFAULT_EMBED_MODEL = "qwen/qwen3-embedding-8b";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// Relative paths in configuration resolve against the repository root, whatever directory npm runs in.

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
  const timeZone = env.RH_TIMEZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ConfigError(
      `RH_TIMEZONE must be an IANA time zone such as Europe/Madrid, got "${timeZone}"`,
      "RH_TIMEZONE",
    );
  }
  const sweepTime = env.RH_SWEEP_TIME?.trim() || "06:00";
  if (!TIME.test(sweepTime))
    throw new ConfigError(`RH_SWEEP_TIME must be HH:MM (24 h), got "${sweepTime}"`, "RH_SWEEP_TIME");
  const nightlyTime = env.RH_NIGHTLY_TIME?.trim() || "02:00";
  if (!TIME.test(nightlyTime))
    throw new ConfigError(`RH_NIGHTLY_TIME must be HH:MM (24 h), got "${nightlyTime}"`, "RH_NIGHTLY_TIME");
  const reviewRaw = (env.RH_REVIEW_TIME?.trim() || "sun 07:00").toLowerCase();
  const [weekday, reviewTime] = reviewRaw.split(/\s+/);
  if (!WEEKDAYS.includes(weekday as Weekday) || !TIME.test(reviewTime ?? ""))
    throw new ConfigError(`RH_REVIEW_TIME must be "<sun..sat> HH:MM", got "${env.RH_REVIEW_TIME}"`, "RH_REVIEW_TIME");
  const contactEmail = env.CONTACT_EMAIL?.trim() || undefined;
  if (contactEmail && !EMAIL.test(contactEmail))
    throw new ConfigError(`CONTACT_EMAIL must be an email address, got "${contactEmail}"`, "CONTACT_EMAIL");
  const embedDims = Number(env.RH_EMBED_DIMS?.trim() || 1024);
  if (!Number.isInteger(embedDims) || embedDims < 32 || embedDims > 4096)
    throw new ConfigError(
      `RH_EMBED_DIMS must be a whole number from 32 to 4096, got "${env.RH_EMBED_DIMS}"`,
      "RH_EMBED_DIMS",
    );
  const papers: PapersConfig = {
    contactEmail,
    embedModel: env.RH_MODEL_EMBED?.trim() || DEFAULT_EMBED_MODEL,
    embedDims,
    s2ApiKey: env.S2_API_KEY?.trim() || undefined,
  };
  const viewerFlag = (env.RH_KB_VIEWER?.trim() || "on").toLowerCase();
  if (!["on", "off"].includes(viewerFlag))
    throw new ConfigError(`RH_KB_VIEWER must be on or off, got "${env.RH_KB_VIEWER}"`, "RH_KB_VIEWER");
  const obsidianVersion = env.RH_KB_OBSIDIAN_VERSION?.trim() || "1.14.4";
  if (!/^\d+\.\d+\.\d+$/.test(obsidianVersion))
    throw new ConfigError(
      `RH_KB_OBSIDIAN_VERSION must look like 1.14.4, got "${obsidianVersion}"`,
      "RH_KB_OBSIDIAN_VERSION",
    );
  const kbViewer = {
    enabled: viewerFlag === "on",
    dir: resolve(REPO_ROOT, env.RH_KB_VIEWER_DIR?.trim() || "/opt/ignis"),
    obsidianVersion,
  };
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
    schedule: { timeZone, sweepTime, nightlyTime, review: { weekday: weekday as Weekday, time: reviewTime } },
    papers,
    kbViewer,
  };
}

/** Values that must never appear in logs or responses. */
export function secretsOf(config: Config): string[] {
  return [config.openrouterKey, config.apiToken, config.clientToken, config.papers.s2ApiKey].filter(
    (s): s is string => !!s && s.length >= 8,
  );
}
