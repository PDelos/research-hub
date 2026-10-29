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
  /** The read-only MCP token (v1-9); without it /mcp is off. */
  mcpToken?: string;
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

type Env = NodeJS.ProcessEnv;

/** A variable without surrounding spaces, or `fallback` when it is unset or blank. */
const setting = (env: Env, name: string, fallback: string) => env[name]?.trim() || fallback;

/** Stop with a ConfigError about `variable` unless `ok`. */
function ensure(ok: boolean, variable: string, message: string): asserts ok {
  if (!ok) throw new ConfigError(message, variable);
}

const isTimeZone = (timeZone: string) => {
  try {
    return !!new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
};

function serverFromEnv(env: Env) {
  const projectName = setting(env, "RH_PROJECT_NAME", "research");
  ensure(
    PROJECT_NAME.test(projectName),
    "RH_PROJECT_NAME",
    `RH_PROJECT_NAME must be 1 to 40 lowercase letters, digits or dashes (no leading or trailing dash), got "${env.RH_PROJECT_NAME}"`,
  );
  const mode = setting(env, "RH_MODE", "live") as Mode;
  ensure(mode === "live" || mode === "offline", "RH_MODE", `RH_MODE must be live or offline, got "${env.RH_MODE}"`);
  const openrouterKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  ensure(
    mode === "offline" || !!openrouterKey,
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY is required in live mode (or set RH_MODE=offline to run without keys)",
  );
  const port = Number(setting(env, "RH_PORT", "4850"));
  ensure(
    Number.isInteger(port) && port >= 1 && port <= 65535,
    "RH_PORT",
    `RH_PORT must be a port number, got "${env.RH_PORT}"`,
  );
  const logLevel = setting(env, "RH_LOG_LEVEL", "info") as LogLevel;
  ensure(
    ["debug", "info", "warn", "error"].includes(logLevel),
    "RH_LOG_LEVEL",
    `RH_LOG_LEVEL must be debug, info, warn or error`,
  );
  return { projectName, mode, openrouterKey, port, logLevel };
}

function scheduleFromEnv(env: Env): Config["schedule"] {
  const timeZone = setting(env, "RH_TIMEZONE", "UTC");
  ensure(
    isTimeZone(timeZone),
    "RH_TIMEZONE",
    `RH_TIMEZONE must be an IANA time zone such as Europe/Madrid, got "${timeZone}"`,
  );
  const sweepTime = setting(env, "RH_SWEEP_TIME", "06:00");
  ensure(TIME.test(sweepTime), "RH_SWEEP_TIME", `RH_SWEEP_TIME must be HH:MM (24 h), got "${sweepTime}"`);
  const nightlyTime = setting(env, "RH_NIGHTLY_TIME", "02:00");
  ensure(TIME.test(nightlyTime), "RH_NIGHTLY_TIME", `RH_NIGHTLY_TIME must be HH:MM (24 h), got "${nightlyTime}"`);
  const [weekday, reviewTime] = setting(env, "RH_REVIEW_TIME", "sun 07:00").toLowerCase().split(/\s+/);
  ensure(
    WEEKDAYS.includes(weekday as Weekday) && TIME.test(reviewTime ?? ""),
    "RH_REVIEW_TIME",
    `RH_REVIEW_TIME must be "<sun..sat> HH:MM", got "${env.RH_REVIEW_TIME}"`,
  );
  return { timeZone, sweepTime, nightlyTime, review: { weekday: weekday as Weekday, time: reviewTime } };
}

function papersFromEnv(env: Env): PapersConfig {
  const contactEmail = env.CONTACT_EMAIL?.trim() || undefined;
  ensure(
    !contactEmail || EMAIL.test(contactEmail),
    "CONTACT_EMAIL",
    `CONTACT_EMAIL must be an email address, got "${contactEmail}"`,
  );
  const embedDims = Number(setting(env, "RH_EMBED_DIMS", "1024"));
  ensure(
    Number.isInteger(embedDims) && embedDims >= 32 && embedDims <= 4096,
    "RH_EMBED_DIMS",
    `RH_EMBED_DIMS must be a whole number from 32 to 4096, got "${env.RH_EMBED_DIMS}"`,
  );
  return {
    contactEmail,
    embedModel: setting(env, "RH_MODEL_EMBED", DEFAULT_EMBED_MODEL),
    embedDims,
    s2ApiKey: env.S2_API_KEY?.trim() || undefined,
  };
}

function kbViewerFromEnv(env: Env): Config["kbViewer"] {
  const viewerFlag = setting(env, "RH_KB_VIEWER", "on").toLowerCase();
  ensure(
    ["on", "off"].includes(viewerFlag),
    "RH_KB_VIEWER",
    `RH_KB_VIEWER must be on or off, got "${env.RH_KB_VIEWER}"`,
  );
  const obsidianVersion = setting(env, "RH_KB_OBSIDIAN_VERSION", "1.14.4");
  ensure(
    /^\d+\.\d+\.\d+$/.test(obsidianVersion),
    "RH_KB_OBSIDIAN_VERSION",
    `RH_KB_OBSIDIAN_VERSION must look like 1.14.4, got "${obsidianVersion}"`,
  );
  return {
    enabled: viewerFlag === "on",
    dir: resolve(REPO_ROOT, setting(env, "RH_KB_VIEWER_DIR", "/opt/ignis")),
    obsidianVersion,
  };
}

/** Host names the server answers to: local names, the project's own, the bind host and RH_ALLOWED_HOSTS. */
function allowedHostsOf(env: Env, projectName: string, host: string): Set<string> {
  const names = ["localhost", "127.0.0.1", `${projectName}.localhost`, host, ...(env.RH_ALLOWED_HOSTS ?? "").split(",")]
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && name !== "0.0.0.0");
  return new Set(names);
}

export function loadConfig(env: Env = process.env): Config {
  const server = serverFromEnv(env);
  const schedule = scheduleFromEnv(env);
  const papers = papersFromEnv(env);
  const kbViewer = kbViewerFromEnv(env);
  const generatedTokens: string[] = [];
  const token = (name: string) => {
    const value = env[name]?.trim();
    if (value) return value;
    generatedTokens.push(name);
    return randomBytes(24).toString("hex");
  };
  const host = setting(env, "RH_HOST", "127.0.0.1");
  const mcpToken = env.RH_MCP_TOKEN?.trim();
  return {
    projectName: server.projectName,
    mode: server.mode,
    host,
    port: server.port,
    dataDir: resolve(REPO_ROOT, setting(env, "RH_DATA_DIR", "./data")),
    logLevel: server.logLevel,
    apiToken: token("RH_API_TOKEN"),
    ...(mcpToken ? { mcpToken } : {}),
    clientToken: token("RH_CLIENT_TOKEN"),
    generatedTokens,
    models: jobModelsFromEnv(env),
    jevModel: jevModelFromEnv(env),
    openrouterKey: server.openrouterKey,
    promptsDir: join(APP_DIR, "prompt_engineering"),
    uiDir: resolve(REPO_ROOT, setting(env, "RH_UI_DIR", "apps/rh-client-browser/dist")),
    allowedHosts: allowedHostsOf(env, server.projectName, host),
    schedule,
    papers,
    kbViewer,
  };
}

/** Values that must never appear in logs or responses. */
export function secretsOf(config: Config): string[] {
  return [config.openrouterKey, config.apiToken, config.clientToken, config.mcpToken, config.papers.s2ApiKey].filter(
    (s): s is string => !!s && s.length >= 8,
  );
}
