// Contributions (spec plugin-system: Declarative contributions, Extension points owned by plugins; design D4).
// Kernel points: tabs, settings, commands, chatTools, jevCommands, prompts, processes, enablement. Any other dotted
// key under `contributes` is a contribution to an extension point a plugin offers under `contributes.extensionPoints`
// (cardinality one or many). Everything is read from manifests without running plugin code; handlers for commands
// and chat tools are registered when the plugin activates, which their activation events trigger on first use.
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { checkLock, readLock } from "@rh/jev";
import { Ajv, type ErrorObject } from "ajv";
import type { Disposable, PluginKernel } from "./lifecycle.ts";
import type { PluginManifest } from "./manifest.ts";
import type { Discovery } from "./registry.ts";
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
        id: { type: "string", pattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)*$" },
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

const ajv = new Ajv({ allErrors: true, strict: false });
const shapeValidators = Object.fromEntries(Object.entries(shapes).map(([k, s]) => [k, ajv.compile(s)]));

function field(prefix: string, error: ErrorObject): string {
  const path = [prefix, ...error.instancePath.split("/").filter(Boolean)].join(".");
  if (error.keyword === "required")
    return `${path}.${(error.params as { missingProperty: string }).missingProperty}: required`;
  if (error.keyword === "additionalProperties")
    return `${path}.${(error.params as { additionalProperty: string }).additionalProperty}: not a known field`;
  return `${path}: ${error.message}`;
}

/** Shape problems of a manifest's `contributes`, and missing folders for Jev commands, prompts and process entries. */
export function contributionProblems(manifest: PluginManifest, dir?: string): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(manifest.contributes)) {
    const kind = (KERNEL_POINTS as readonly string[]).includes(key) ? key : POINT_ID.test(key) ? "point" : undefined;
    if (!kind) {
      problems.push(
        `contributes.${key}: not a known contribution point (extension points are named like papers.source)`,
      );
      continue;
    }
    const validate = shapeValidators[kind];
    if (!validate(value)) problems.push(...(validate.errors ?? []).map((e) => field(`contributes.${key}`, e)));
  }
  const c = contributionsOf(manifest);
  const seen = new Set<string>();
  for (const [key, list] of [
    ["tabs", c.tabs.map((t) => t.id)],
    ["commands", c.commands.map((t) => t.id)],
    ["chatTools", c.chatTools.map((t) => t.name)],
  ] as const)
    for (const id of list) {
      if (seen.has(`${key}:${id}`)) problems.push(`contributes.${key}: "${id}" is declared twice`);
      seen.add(`${key}:${id}`);
    }
  for (const id of c.commands.map((cmd) => cmd.id))
    if (
      !manifest.activationEvents.includes(`onCommand:${id}`) &&
      !manifest.activationEvents.includes("*") &&
      !manifest.activationEvents.includes("onStartup")
    )
      problems.push(`contributes.commands: "${id}" needs the activation event onCommand:${id}`);
  for (const tool of c.chatTools)
    if (
      !manifest.activationEvents.includes(`onChatTool:${tool.name}`) &&
      !manifest.activationEvents.includes("*") &&
      !manifest.activationEvents.includes("onStartup")
    )
      problems.push(`contributes.chatTools: "${tool.name}" needs the activation event onChatTool:${tool.name}`);
  if (dir) {
    for (const path of c.jevCommands)
      if (!existsSync(join(resolvePath(dir, path), "command.json")))
        problems.push(`contributes.jevCommands: ${path} has no command.json`);
    for (const p of c.prompts)
      if (!existsSync(resolvePath(dir, p.path))) problems.push(`contributes.prompts: ${p.path} does not exist`);
  }
  return problems;
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
  const c = manifest.contributes as Record<string, unknown>;
  const list = <T>(key: string) => (Array.isArray(c[key]) ? (c[key] as T[]) : []);
  const points: Record<string, PointContribution[]> = {};
  for (const [key, value] of Object.entries(c))
    if (POINT_ID.test(key) && Array.isArray(value)) points[key] = value as PointContribution[];
  return {
    tabs: list<TabContribution>("tabs"),
    ...(c.settings ? { settings: c.settings as Contributions["settings"] } : {}),
    commands: list<CommandContribution>("commands"),
    chatTools: list<ChatToolContribution>("chatTools"),
    jevCommands: list<string>("jevCommands"),
    prompts: list<PromptContribution>("prompts"),
    processes: list<ProcessContribution>("processes"),
    extensionPoints: (c.extensionPoints ?? {}) as Record<string, ExtensionPointDecl>,
    points,
  };
}

export class ContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributionError";
  }
}

type Handler = (args: unknown) => unknown;

/** Name → owning plugin id. */
function owners<T extends { pluginId: string }>(items: T[], name: (t: T) => string): Map<string, string> {
  return new Map(items.map((t) => [name(t), t.pluginId]));
}

/** What enabled plugins contribute, resolved across plugins; the kernel's view for the API, the desk and the UI. */
export class ContributionRegistry {
  private readonly commandHandlers = new Map<string, { pluginId: string; handler: Handler }>();
  private readonly toolHandlers = new Map<string, { pluginId: string; handler: Handler }>();
  private readonly pointValidators = new Map<string, ReturnType<typeof ajv.compile>>();

  constructor(
    private readonly kernel: PluginKernel,
    private readonly discovery: Discovery,
  ) {}

  /** Plugins that can run, in discovery order (built-ins first). */
  private plugins(): { id: string; manifest: PluginManifest; dir: string; c: Contributions }[] {
    const available = new Set(this.kernel.available());
    return [...this.discovery.plugins.values()]
      .filter((p) => available.has(p.manifest.id))
      .map((p) => ({ id: p.manifest.id, manifest: p.manifest, dir: p.dir, c: contributionsOf(p.manifest) }));
  }

  tabs(): (TabContribution & { pluginId: string })[] {
    const seen = new Set<string>();
    return this.plugins()
      .flatMap((p) => p.c.tabs.map((t) => ({ ...t, pluginId: p.id })))
      .filter((t) => !seen.has(t.id) && seen.add(t.id))
      .toSorted((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  }

  commands(): (CommandContribution & { pluginId: string })[] {
    return this.plugins().flatMap((p) => p.c.commands.map((cmd) => ({ ...cmd, pluginId: p.id })));
  }

  /** Chat tools of available plugins (the first declaration of a name wins); `desk` limits to the desk's allow-list. */
  chatTools(options: { desk?: boolean } = {}): (ChatToolContribution & { pluginId: string })[] {
    const seen = new Set<string>();
    return this.plugins()
      .flatMap((p) => p.c.chatTools.map((t) => ({ ...t, pluginId: p.id })))
      .filter((t) => !seen.has(t.name) && seen.add(t.name))
      .filter((t) => !options.desk || t.desk !== false);
  }

  /** Jev command name → its folder, across available plugins. */
  jevCommands(): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of this.plugins())
      for (const path of p.c.jevCommands) {
        const folder = resolvePath(p.dir, path);
        const name = folder.split("/").at(-1)!;
        if (!out.has(name)) out.set(name, folder);
      }
    return out;
  }

  /** The prompt folder for an agent, from the first available plugin that contributes one. */
  promptDir(agent: string): string | undefined {
    for (const p of this.plugins()) {
      const prompt = p.c.prompts.find((x) => x.agent === agent);
      if (prompt) return resolvePath(p.dir, prompt.path);
    }
    return undefined;
  }

  processes(pluginId: string): ProcessContribution[] {
    const plugin = this.discovery.plugins.get(pluginId);
    return plugin ? contributionsOf(plugin.manifest).processes : [];
  }

  /** Register the handler of a declared command (from the plugin's activate); disposed with the plugin. */
  registerCommand(pluginId: string, id: string, handler: Handler): Disposable {
    return this.register(this.commandHandlers, "commands", pluginId, id, handler);
  }

  registerChatTool(pluginId: string, name: string, handler: Handler): Disposable {
    return this.register(this.toolHandlers, "chatTools", pluginId, name, handler);
  }

  private register(
    map: Map<string, { pluginId: string; handler: Handler }>,
    kind: "commands" | "chatTools",
    pluginId: string,
    id: string,
    handler: Handler,
  ): Disposable {
    const manifest = this.discovery.plugins.get(pluginId)?.manifest;
    const declared = manifest && contributionsOf(manifest)[kind].some((x) => ("id" in x ? x.id : x.name) === id);
    if (!declared)
      throw new ContributionError(
        `${pluginId} did not declare ${kind === "commands" ? "command" : "chat tool"} ${id} in contributes.${kind}`,
      );
    map.set(id, { pluginId, handler });
    return { dispose: () => void (map.get(id)?.handler === handler && map.delete(id)) };
  }

  /** Run a command, activating its plugin first (onCommand:<id>). */
  executeCommand(id: string, args?: unknown): Promise<unknown> {
    const owner = this.commands().find((c) => c.id === id)?.pluginId;
    return this.invoke(this.commandHandlers, `onCommand:${id}`, owner, id, "command", args);
  }

  /** Call a chat tool, activating its plugin first (onChatTool:<name>). */
  callChatTool(name: string, args?: unknown): Promise<unknown> {
    const owner = this.chatTools().find((t) => t.name === name)?.pluginId;
    return this.invoke(this.toolHandlers, `onChatTool:${name}`, owner, name, "chat tool", args);
  }

  private async invoke(
    map: Map<string, { pluginId: string; handler: Handler }>,
    event: string,
    owner: string | undefined,
    id: string,
    what: string,
    args: unknown,
  ): Promise<unknown> {
    if (!owner) throw new ContributionError(`no enabled plugin offers the ${what} ${id}`);
    await this.kernel.fire(event);
    await this.kernel.activate(owner);
    const entry = map.get(id);
    if (!entry) throw new ContributionError(`${owner} did not register the ${what} ${id} when it activated`);
    return entry.handler(args);
  }

  /** Extension points offered by available plugins. */
  extensionPoints(): Map<string, { pluginId: string; decl: ExtensionPointDecl }> {
    const out = new Map<string, { pluginId: string; decl: ExtensionPointDecl }>();
    for (const p of this.plugins())
      for (const [point, decl] of Object.entries(p.c.extensionPoints))
        if (!out.has(point)) out.set(point, { pluginId: p.id, decl });
    return out;
  }

  /**
   * Valid contributions to a point from available plugins (invalid ones are left out and listed by problems()).
   * With `activate`, fires onExtensionPoint:<point> so contributors that wait for it start.
   */
  async contributionsTo(
    point: string,
    options: { activate?: boolean } = {},
  ): Promise<(PointContribution & { pluginId: string })[]> {
    if (options.activate) await this.kernel.fire(`onExtensionPoint:${point}`);
    return this.validContributions(point);
  }

  private validContributions(point: string): (PointContribution & { pluginId: string })[] {
    const offer = this.extensionPoints().get(point);
    if (!offer) return [];
    const validate = this.pointValidator(point, offer.decl);
    return this.plugins().flatMap((p) =>
      (p.c.points[point] ?? []).filter((c) => validate(c)).map((c) => ({ ...c, pluginId: p.id })),
    );
  }

  /** The active contribution of a one-cardinality point: the offering plugin's setting, else its default, else the first. */
  activeContribution(
    point: string,
    settings: Record<string, unknown>,
  ): (PointContribution & { pluginId: string }) | undefined {
    const offer = this.extensionPoints().get(point);
    if (!offer || offer.decl.cardinality !== "one") return undefined;
    const all = this.validContributions(point);
    const chosen = (settings[point] as string | undefined) ?? offer.decl.default;
    return all.find((c) => c.id === chosen) ?? all[0];
  }

  private pointValidator(point: string, decl: ExtensionPointDecl) {
    let validate = this.pointValidators.get(point);
    if (!validate) {
      validate = ajv.compile({ type: "object", required: ["id"], ...decl.schema });
      this.pointValidators.set(point, validate);
    }
    return validate;
  }

  /** Problems that do not stop a plugin: unknown points, invalid point contributions, names taken by another plugin. */
  problems(pluginId: string): string[] {
    const plugin = this.discovery.plugins.get(pluginId);
    if (!plugin) return [];
    const c = contributionsOf(plugin.manifest);
    const offers = this.extensionPoints();
    const out: string[] = [];
    for (const [point, list] of Object.entries(c.points)) {
      const offer = offers.get(point);
      if (!offer) {
        out.push(`contributes to ${point}, which no enabled plugin offers`);
        continue;
      }
      const validate = this.pointValidator(point, offer.decl);
      for (const item of list)
        if (!validate(item))
          out.push(
            `contribution ${point}/${item.id}: ${(validate.errors ?? []).map((e) => field(point, e)).join("; ")}`,
          );
    }
    const tools = owners(this.chatTools(), (t) => t.name);
    for (const t of c.chatTools)
      if (tools.has(t.name) && tools.get(t.name) !== pluginId)
        out.push(`chat tool ${t.name} is already offered by ${tools.get(t.name)}`);
    const tabs = owners(this.tabs(), (t) => t.id);
    for (const t of c.tabs)
      if (tabs.has(t.id) && tabs.get(t.id) !== pluginId)
        out.push(`tab ${t.id} is already contributed by ${tabs.get(t.id)}`);
    const jev = this.jevCommands();
    for (const path of c.jevCommands) {
      const folder = resolvePath(plugin.dir, path);
      const name = folder.split("/").at(-1)!;
      if (jev.has(name) && jev.get(name) !== folder)
        out.push(`Jev command ${name} is already contributed by another plugin`);
    }
    return out;
  }
}

/**
 * The Jev lock check across plugins: every contributed command must be recorded in the commands.lock.json of its
 * folder, and names must be unique across plugins.
 */
export function checkJevAcrossPlugins(discovery: Discovery): string[] {
  const problems: string[] = [];
  const byName = new Map<string, string>();
  const dirs = new Set<string>();
  for (const p of discovery.plugins.values())
    for (const path of contributionsOf(p.manifest).jevCommands) {
      const folder = resolvePath(p.dir, path);
      const name = folder.split("/").at(-1)!;
      const other = byName.get(name);
      if (other && other !== folder) problems.push(`${name}: contributed twice (${other} and ${folder})`);
      byName.set(name, folder);
      dirs.add(dirname(folder));
    }
  for (const dir of dirs) problems.push(...checkLock(dir, readLock(dir)).map((p) => `${dir}: ${p}`));
  return problems;
}
