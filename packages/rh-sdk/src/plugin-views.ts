// What the hub tells clients about plugins (v1.0): their states, contributions, settings, history and installs.

/** active: running; inactive: enabled, waiting for an activation event; blocked: a dependency is not available. */
export type PluginRunState = "active" | "activating" | "inactive" | "disabled" | "failed" | "incompatible" | "blocked";

export interface PluginPermissionsView {
  network?: string[];
  files?: string[];
  secrets?: string[];
  budgetUsdPerDay?: number;
}

export interface PluginContributionsDetail {
  tabs: { id: string; title: string; view: string; order?: number }[];
  commands: { id: string; title: string }[];
  chatTools: { name: string; description: string; desk?: boolean }[];
  jevCommands: string[];
  prompts: { agent: string; path: string }[];
  processes: { id: string; title?: string; entry: string }[];
  extensionPoints: Record<string, { description?: string; cardinality: "one" | "many"; default?: string }>;
  /** Contributions to extension points other plugins offer, by point. */
  points: Record<string, { id: string; [field: string]: unknown }[]>;
}

export interface PluginSettingProperty {
  type?: string;
  description?: string;
  default?: unknown;
  env?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface PluginHistoryEntry {
  id: string;
  time: string;
  message: string;
  /** user, kernel, or proposal:<id> */
  actor: string;
}

export interface PluginDetails extends PluginSummary {
  engines: string;
  activationEvents: string[];
  dependencies: Record<string, string>;
  /** Enabled plugins that depend on this one (disabling asks first). */
  dependents: string[];
  required: boolean;
  permissions: PluginPermissionsView;
  contributions: PluginContributionsDetail;
  settings: { properties: Record<string, PluginSettingProperty>; values: Record<string, unknown> };
  /** Problems that do not stop the plugin (unknown extension points, names taken by another plugin). */
  problems: string[];
  /** Changes that mention this plugin, newest first. */
  history: PluginHistoryEntry[];
}

export interface PluginList {
  kernelApi: string;
  plugins: PluginSummary[];
  /** Plugin folders whose manifest is invalid, with the problems. */
  invalid: { dir: string; problems: string[] }[];
}

export interface PluginTabView {
  id: string;
  title: string;
  view: string;
  order?: number;
  pluginId: string;
  builtin: boolean;
  /** External plugins: the module to load (it defines the custom element named by `view`). */
  script?: string;
}

export interface PluginContributionsView {
  tabs: PluginTabView[];
  /** The kb.viewer extension point: what the Knowledge base tab shows. */
  viewer: {
    active: { id: string; title: string; view: string; pluginId: string } | null;
    options: { id: string; title: string; pluginId: string }[];
  };
  /** Settings of every available plugin that declares any, grouped by plugin. */
  settings: {
    pluginId: string;
    displayName: string;
    properties: Record<string, PluginSettingProperty>;
    values: Record<string, unknown>;
  }[];
}

export type PluginInstallSource = { folder: string } | { git: string; ref?: string };

export interface PluginInstallPlan {
  planId: string;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  replaces?: string;
  source: { kind: string; path?: string; url?: string; ref?: string };
  permissions: PluginPermissionsView;
  contributions: PluginContributionsDetail;
}

export type PluginKind = "core" | "slot" | "addon" | "preference";
export type PluginTopic =
  | "finding"
  | "understanding"
  | "ranking"
  | "knowledge"
  | "agents"
  | "integrations"
  | "interface";

export interface PluginSummary {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  builtin: boolean;
  /** What may change (v1.3): core never; a slot is replaced; add-ons and preferences are chosen. */
  kind: PluginKind;
  topic: PluginTopic;
  /** For kind slot: the slot it fills. */
  slot?: string;
  state: PluginRunState;
  /** Why the plugin is not active (blocked, incompatible) or the error that made it fail. */
  reason?: string;
  activatedAt?: string;
}
