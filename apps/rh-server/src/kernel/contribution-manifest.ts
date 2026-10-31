// Contributions as manifests declare them (spec plugin-system: Declarative contributions; design D4): the kernel
// points' shapes, the problems a manifest's `contributes` can have, and every list read with defaults. Nothing here
// runs plugin code.
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import type { PluginManifest } from "./manifest.ts";
import type { ExtensionPointDecl } from "./settings.ts";

export interface TabContribution {
  id: string;
  title: string;
  /** Built-in view id (a component bundled with the UI) or a custom element from the plugin's `browser` entry. */
  view: string;
  order?: number;
  icon?: string;
}
export interface CommandContribution {
  id: string;
  title: string;
}
export interface ChatToolContribution {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
  /** Offered to the research desk (default true); false keeps it for the plugin's own agents. */
  desk?: boolean;
}
export interface PromptContribution {
  agent: string;
  path: string;
}
export interface ProcessContribution {
  id: string;
  title?: string;
  entry: string;
  args?: string[];
}
export interface PointContribution {
  id: string;
  [field: string]: unknown;
}

export const KERNEL_POINTS = [
  "tabs",
  "settings",
  "commands",
  "chatTools",
  "jevCommands",
  "prompts",
  "processes",
  "enablement",
  "extensionPoints",
] as const;
const POINT_ID = /^[a-z0-9-]+\.[a-z0-9.-]+$/;

const shapes = {
  tabs: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "view"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9-]+$" },
        title: { type: "string", minLength: 1, maxLength: 40 },
        view: { type: "string", minLength: 1 },
        order: { type: "number" },
        icon: { type: "string" },
      },
    },
  },
  settings: {
    type: "object",
    additionalProperties: false,
    required: ["properties"],
    properties: {
      type: { const: "object" },
      properties: {
        type: "object",
        propertyNames: { pattern: "^[a-zA-Z][a-zA-Z0-9.]*$" },
        additionalProperties: {
          type: "object",
          required: ["type"],
          properties: { env: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" } },
        },
      },
    },
  },
  commands: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)*$" },
        title: { type: "string", minLength: 1 },
      },
    },
  },
  chatTools: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "parameters"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        description: { type: "string", minLength: 1 },
        parameters: { type: "object" },
        desk: { type: "boolean" },
      },
    },
  },
  jevCommands: { type: "array", items: { type: "string", minLength: 1 } },
  prompts: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["agent", "path"],
      properties: { agent: { type: "string", pattern: "^[a-z0-9-]+$" }, path: { type: "string", minLength: 1 } },
    },
  },
  processes: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "entry"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9-]+$" },
        title: { type: "string" },
        entry: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" } },
      },
    },
  },
  enablement: {
    type: "object",
    additionalProperties: false,
    required: ["env"],
    properties: { env: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" } },
  },
  extensionPoints: {
    type: "object",
    propertyNames: { pattern: POINT_ID.source },
    additionalProperties: {
      type: "object",
      additionalProperties: false,
      required: ["cardinality"],
      properties: {
        description: { type: "string" },
        cardinality: { enum: ["one", "many"] },
        schema: { type: "object" },
        default: { type: "string" },
      },
    },
  },
  point: {
    type: "array",
    items: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-z0-9-]+$" } } },
  },
} as const;

/** One validator instance for shapes and extension-point schemas (compiled schemas are cached by it). */
export const ajv = new Ajv({ allErrors: true, strict: false });
const shapeValidators = Object.fromEntries(Object.entries(shapes).map(([k, s]) => [k, ajv.compile(s)]));

export function field(prefix: string, error: ErrorObject): string {
  const path = [prefix, ...error.instancePath.split("/").filter(Boolean)].join(".");
  if (error.keyword === "required")
    return `${path}.${(error.params as { missingProperty: string }).missingProperty}: required`;
  if (error.keyword === "additionalProperties")
    return `${path}.${(error.params as { additionalProperty: string }).additionalProperty}: not a known field`;
  return `${path}: ${error.message}`;
}

function shapeProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(manifest.contributes)) {
    const kind = contributionKind(key);
    if (!kind) {
      problems.push(
        `contributes.${key}: not a known contribution point (extension points are named like papers.source)`,
      );
      continue;
    }
    const validate = shapeValidators[kind];
    if (!validate(value)) problems.push(...(validate.errors ?? []).map((e) => field(`contributes.${key}`, e)));
  }
  return problems;
}

function duplicateProblems(contributions: Contributions): string[] {
  const problems: string[] = [];
  for (const [key, ids] of [
    ["tabs", contributions.tabs.map((t) => t.id)],
    ["commands", contributions.commands.map((t) => t.id)],
    ["chatTools", contributions.chatTools.map((t) => t.name)],
  ] as const)
    for (const [index, id] of ids.entries())
      if (ids.indexOf(id) !== index) problems.push(`contributes.${key}: "${id}" is declared twice`);
  return problems;
}

/** Commands and chat tools need an activation event that starts their plugin before they are called. */
function activationProblems(manifest: PluginManifest, contributions: Contributions): string[] {
  const events = manifest.activationEvents;
  const activates = (event: string) => events.includes(event) || events.includes("*") || events.includes("onStartup");
  return [
    ...contributions.commands
      .filter((command) => !activates(`onCommand:${command.id}`))
      .map((command) => `contributes.commands: "${command.id}" needs the activation event onCommand:${command.id}`),
    ...contributions.chatTools
      .filter((tool) => !activates(`onChatTool:${tool.name}`))
      .map((tool) => `contributes.chatTools: "${tool.name}" needs the activation event onChatTool:${tool.name}`),
  ];
}

function fileProblems(contributions: Contributions, dir: string): string[] {
  return [
    ...contributions.jevCommands
      .filter((path) => !existsSync(join(resolvePath(dir, path), "command.json")))
      .map((path) => `contributes.jevCommands: ${path} has no command.json`),
    ...contributions.prompts
      .filter((prompt) => !existsSync(resolvePath(dir, prompt.path)))
      .map((prompt) => `contributes.prompts: ${prompt.path} does not exist`),
  ];
}

/** Shape problems of a manifest's `contributes`, and missing folders for Jev commands, prompts and process entries. */
export function contributionProblems(manifest: PluginManifest, dir?: string): string[] {
  const contributions = contributionsOf(manifest);
  return [
    ...shapeProblems(manifest),
    ...duplicateProblems(contributions),
    ...activationProblems(manifest, contributions),
    ...(dir ? fileProblems(contributions, dir) : []),
  ];
}

export interface Contributions {
  tabs: TabContribution[];
  settings?: { properties: Record<string, unknown> };
  commands: CommandContribution[];
  chatTools: ChatToolContribution[];
  jevCommands: string[];
  prompts: PromptContribution[];
  processes: ProcessContribution[];
  extensionPoints: Record<string, ExtensionPointDecl>;
  /** Contributions to plugin-offered extension points, by point id. */
  points: Record<string, PointContribution[]>;
}

/** A manifest's contributions with every list present (the manifest must have passed contributionProblems). */
export function contributionsOf(manifest: PluginManifest): Contributions {
  const contributes = manifest.contributes as Record<string, unknown>;
  const list = <T>(key: string) => (Array.isArray(contributes[key]) ? (contributes[key] as T[]) : []);
  const points: Record<string, PointContribution[]> = {};
  for (const [key, value] of Object.entries(contributes))
    if (POINT_ID.test(key) && Array.isArray(value)) points[key] = value as PointContribution[];
  return {
    tabs: list<TabContribution>("tabs"),
    ...(contributes.settings ? { settings: contributes.settings as Contributions["settings"] } : {}),
    commands: list<CommandContribution>("commands"),
    chatTools: list<ChatToolContribution>("chatTools"),
    jevCommands: list<string>("jevCommands"),
    prompts: list<PromptContribution>("prompts"),
    processes: list<ProcessContribution>("processes"),
    extensionPoints: (contributes.extensionPoints ?? {}) as Record<string, ExtensionPointDecl>,
    points,
  };
}

/** A kernel point by its own name, "point" for an extension point (papers.source), else unknown. */
function contributionKind(key: string): string | undefined {
  if ((KERNEL_POINTS as readonly string[]).includes(key)) return key;
  return POINT_ID.test(key) ? "point" : undefined;
}
