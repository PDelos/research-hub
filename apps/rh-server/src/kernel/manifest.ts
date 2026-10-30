// Plugin manifests (spec plugin-system: Plugin manifest; design D1): an `rh-plugin.json` per plugin, modeled on a
// VS Code extension's package.json. Validated with a JSON schema; every problem names its field.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import semver from "semver";

/** The kernel API version plugins declare compatibility with in `engines.research-hub`. */
export const KERNEL_API_VERSION = "1.0.0";
export const MANIFEST_FILE = "rh-plugin.json";

export type ActivationEvent = string;
export type PluginKind = "core" | "slot" | "addon" | "preference";
export type PluginTopic =
  | "finding"
  | "understanding"
  | "ranking"
  | "knowledge"
  | "agents"
  | "integrations"
  | "interface";

export interface PluginPermissions {
  /** Hosts the plugin may reach (exact names; "*.example.org" for subdomains). */
  network?: string[];
  /** File scopes: "own" (its folder), "vault:read", "vault:read-write". */
  files?: string[];
  /** Secret names it may read (e.g. "OPENROUTER_API_KEY"). */
  secrets?: string[];
  /** Spending limit for model, Jev and embedding calls per day, in USD. */
  budgetUsdPerDay?: number;
}

export interface PluginManifest {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  engines: { "research-hub": string };
  main?: string;
  browser?: string;
  activationEvents: ActivationEvent[];
  contributes: Record<string, unknown>;
  /** Plugin id → semver range. */
  dependencies: Record<string, string>;
  /** Built-ins only: the hub needs this plugin, so it cannot be disabled. */
  required?: boolean;
  /** What may change (EVOLUTION.md §0.1): core (never), slot (one active, benchmarked), add-on, preference. */
  kind: PluginKind;
  topic: PluginTopic;
  /** For kind slot: which slot it fills (e.g. "embedder"). */
  slot?: string;
  permissions: PluginPermissions;
}

const ACTIVATION =
  "^(\\*|onStartup|onView:[a-z0-9-]+|onCommand:[a-zA-Z0-9.-]+|onChatTool:[a-z0-9_]+|onExtensionPoint:[a-z0-9.-]+|onSchedule:[a-z0-9-]+)$";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "displayName", "engines", "activationEvents"],
  properties: {
    $schema: { type: "string" },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9-]*$", maxLength: 80 },
    version: { type: "string", minLength: 5 },
    displayName: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", maxLength: 500 },
    engines: {
      type: "object",
      additionalProperties: false,
      required: ["research-hub"],
      properties: { "research-hub": { type: "string", minLength: 1 } },
    },
    main: { type: "string", pattern: "^[^/].*\\.(ts|js|mjs)$" },
    browser: { type: "string", pattern: "^[^/].*\\.(ts|js|mjs)$" },
    activationEvents: { type: "array", items: { type: "string", pattern: ACTIVATION }, uniqueItems: true },
    contributes: { type: "object" },
    dependencies: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    required: { type: "boolean" },
    kind: { enum: ["core", "slot", "addon", "preference"] },
    topic: { enum: ["finding", "understanding", "ranking", "knowledge", "agents", "integrations", "interface"] },
    slot: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        network: { type: "array", items: { type: "string", pattern: "^(\\*\\.)?[a-z0-9.-]+$" } },
        files: { type: "array", items: { type: "string", enum: ["own", "vault:read", "vault:read-write"] } },
        secrets: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" } },
        budgetUsdPerDay: { type: "number", minimum: 0, maximum: 1000 },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export class ManifestInvalid extends Error {
  constructor(
    readonly where: string,
    readonly problems: string[],
  ) {
    super(`${where}: ${problems.join("; ")}`);
    this.name = "ManifestInvalid";
  }
}

/** "engines.research-hub: required", "activationEvents.0: must match …", "version: not a semantic version". */
function describe(error: ErrorObject): string {
  const path = error.instancePath.replace(/^\//, "").replaceAll("/", ".");
  if (error.keyword === "required") {
    const field = (error.params as { missingProperty: string }).missingProperty;
    // A missing `engines` object is reported as the field that matters.
    return `${path ? `${path}.` : ""}${field === "engines" && !path ? "engines.research-hub" : field}: required`;
  }
  if (error.keyword === "additionalProperties") {
    const field = (error.params as { additionalProperty: string }).additionalProperty;
    return `${path ? `${path}.` : ""}${field}: not a known field`;
  }
  if (error.keyword === "pattern" && path.startsWith("activationEvents"))
    return `${path}: not a known activation event (onStartup, onView:<tab>, onCommand:<id>, onChatTool:<name>, onExtensionPoint:<point>, onSchedule:<kind>)`;
  return `${path || "manifest"}: ${error.message}`;
}

/** What the schema cannot check: versions and ranges that must parse, and a slot plugin's slot. */
function semanticProblems(fields: Partial<PluginManifest>): string[] {
  const problems: string[] = [];
  if (typeof fields.version === "string" && !semver.valid(fields.version))
    problems.push(`version: "${fields.version}" is not a semantic version`);
  const range = fields.engines?.["research-hub"];
  if (typeof range === "string" && !semver.validRange(range))
    problems.push(`engines.research-hub: "${range}" is not a version range`);
  if (fields.kind === "slot" && !fields.slot) problems.push("slot: required for a plugin of kind slot");
  for (const [id, dependencyRange] of Object.entries(fields.dependencies ?? {}))
    if (!semver.validRange(dependencyRange))
      problems.push(`dependencies.${id}: "${dependencyRange}" is not a version range`);
  return problems;
}

/** Validate a parsed manifest; returns it with defaults filled in, or throws ManifestInvalid. */
export function parseManifest(raw: unknown, where = MANIFEST_FILE): PluginManifest {
  const problems: string[] = [];
  if (!validate(raw)) problems.push(...(validate.errors ?? []).map(describe));
  const fields = raw as Partial<PluginManifest> & { builtin?: unknown };
  if (fields && typeof fields === "object") problems.push(...semanticProblems(fields));
  if (problems.length) throw new ManifestInvalid(where, [...new Set(problems)]);
  return {
    ...(fields as PluginManifest),
    contributes: fields.contributes ?? {},
    kind: fields.kind ?? "addon",
    topic: fields.topic ?? "integrations",
    dependencies: fields.dependencies ?? {},
    permissions: fields.permissions ?? {},
  };
}

export function loadManifest(dir: string): PluginManifest {
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) throw new ManifestInvalid(dir, [`${MANIFEST_FILE}: missing`]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ManifestInvalid(file, [`not valid JSON (${error instanceof Error ? error.message : String(error)})`]);
  }
  return parseManifest(raw, file);
}

/** Why the kernel cannot run this plugin, or undefined when `engines.research-hub` accepts the kernel API. */
export function engineProblem(manifest: PluginManifest, kernel = KERNEL_API_VERSION): string | undefined {
  const range = manifest.engines["research-hub"];
  return semver.satisfies(kernel, range) ? undefined : `needs kernel API ${range}, this hub has ${kernel}`;
}
