// Plugin settings (spec plugin-system: Plugin settings; design D4): declared as JSON schema properties under
// `contributes.settings`, defaulted from the schema and then from the environment (`env` mapping, so v0's variables
// keep working), overridden by what the project saved, and validated on every change with the field and the rule.
// Offering a one-cardinality extension point adds a string setting named after the point (its active contribution).
import { Ajv, type ErrorObject } from "ajv";
import type { PluginManifest } from "./manifest.ts";

export interface SettingProperty {
  type?: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  default?: unknown;
  /** Environment variable that supplies the default (v0 compatibility). */
  env?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  [keyword: string]: unknown;
}

export interface ExtensionPointDecl {
  description?: string;
  cardinality: "one" | "many";
  /** JSON schema every contribution must satisfy (besides its `id`). */
  schema?: Record<string, unknown>;
  /** For `one`: the contribution id active when nothing is saved. */
  default?: string;
}

export class SettingsInvalid extends Error {
  constructor(
    readonly pluginId: string,
    readonly problems: string[],
  ) {
    super(`${pluginId} settings: ${problems.join("; ")}`);
    this.name = "SettingsInvalid";
  }
}

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
const validators = new WeakMap<PluginManifest, ReturnType<typeof ajv.compile>>();

/** The plugin's settings properties, including one per one-cardinality extension point it offers. */
export function settingsProperties(manifest: PluginManifest): Record<string, SettingProperty> {
  const declared =
    (manifest.contributes.settings as { properties?: Record<string, SettingProperty> } | undefined)?.properties ?? {};
  const points = (manifest.contributes.extensionPoints ?? {}) as Record<string, ExtensionPointDecl>;
  const implicit: Record<string, SettingProperty> = {};
  for (const [point, decl] of Object.entries(points))
    if (decl.cardinality === "one")
      implicit[point] = {
        type: "string",
        description: decl.description ?? `Which ${point} contribution is active`,
        ...(decl.default ? { default: decl.default } : {}),
      };
  return { ...implicit, ...declared };
}

function validator(manifest: PluginManifest) {
  let validate = validators.get(manifest);
  if (!validate) {
    const properties = Object.fromEntries(
      Object.entries(settingsProperties(manifest)).map(([key, { env: _env, default: _default, ...rest }]) => [
        key,
        rest,
      ]),
    );
    validate = ajv.compile({ type: "object", additionalProperties: false, properties });
    validators.set(manifest, validate);
  }
  return validate;
}

function describe(error: ErrorObject, properties: Record<string, SettingProperty>): string {
  const key = error.instancePath.replace(/^\//, "").split("/")[0];
  if (error.keyword === "additionalProperties")
    return `${(error.params as { additionalProperty: string }).additionalProperty}: not a known setting`;
  const settingProperty = properties[key] ?? {};
  if (
    (error.keyword === "minimum" || error.keyword === "maximum") &&
    settingProperty.minimum !== undefined &&
    settingProperty.maximum !== undefined
  )
    return `${key}: must be ${settingProperty.type === "integer" ? "an integer" : "a number"} from ${settingProperty.minimum} to ${settingProperty.maximum}`;
  if (error.keyword === "enum")
    return `${key}: must be one of ${(settingProperty.enum ?? []).map((v) => JSON.stringify(v)).join(", ")}`;
  return `${key || "settings"}: ${error.message}`;
}

/** Throw SettingsInvalid unless `values` satisfies the plugin's settings schema. */
export function validateSettings(manifest: PluginManifest, values: Record<string, unknown>): void {
  const validate = validator(manifest);
  if (validate(values)) return;
  const properties = settingsProperties(manifest);
  throw new SettingsInvalid(manifest.id, [...new Set((validate.errors ?? []).map((e) => describe(e, properties)))]);
}

function fromEnv(raw: string, type: SettingProperty["type"]): unknown {
  if (type === "integer" || type === "number") return Number(raw);
  if (type === "boolean") return !["0", "false", "off", "no", ""].includes(raw.trim().toLowerCase());
  if (type === "array")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return raw;
}

/** Schema defaults, then environment defaults, then saved values. */
export function resolveSettings(
  manifest: PluginManifest,
  saved: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(settingsProperties(manifest))) {
    if (p.default !== undefined) out[key] = structuredClone(p.default);
    const raw = p.env ? env[p.env] : undefined;
    if (raw !== undefined && raw !== "") out[key] = fromEnv(raw, p.type);
  }
  return { ...out, ...saved };
}

/** Whether the plugin is an advanced feature, enabled only in the full profile (`contributes.enablement.profile`). */
export function fullProfileOnly(manifest: PluginManifest): boolean {
  return (manifest.contributes.enablement as { profile?: string } | undefined)?.profile === "full";
}

/**
 * Whether a plugin starts enabled in a new lockfile: `contributes.enablement.env` set to off/false/0 disables it,
 * and an advanced feature (`enablement.profile: "full"`) starts disabled unless RH_PROFILE is full.
 */
export function initiallyEnabled(manifest: PluginManifest, env: NodeJS.ProcessEnv = process.env): boolean {
  // Unset means full, as before profiles existed; the configuration always sets RH_PROFILE (default core).
  if (fullProfileOnly(manifest) && (env.RH_PROFILE ?? "full") !== "full") return false;
  const name = (manifest.contributes.enablement as { env?: string } | undefined)?.env;
  const raw = name ? env[name] : undefined;
  return raw === undefined || !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}
