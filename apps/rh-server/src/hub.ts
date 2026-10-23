// The hub: one model catalog and one Jev client for the process, and the projects it serves. v0.0 knows only the
// built-in `default` project; project creation arrives with v0-1-projects. Projects open lazily, once.
import type { Extension } from "@earendil-works/pi-durable";
import { createModelCatalog, installScriptedFaux, type FauxRule, type ModelCatalog } from "@rh/durable-agent";
import { JevClient } from "@rh/jev";
import type { Config } from "./config.ts";
import { notFound } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { openProject, type ProjectRuntime } from "./project.ts";

export const DEFAULT_PROJECT = "default";

export interface HubOptions {
  /** Scripted faux replies (offline mode and tests). */
  fauxRules?: FauxRule[];
  fauxTokensPerSecond?: number;
  /** Extra extensions and allowed desk tools for every project (tests). */
  extensions?: Extension[];
  deskTools?: readonly string[];
}

export class Hub {
  readonly catalog: ModelCatalog;
  readonly jev: JevClient;
  readonly startedAt = Date.now();
  private readonly opening = new Map<string, Promise<ProjectRuntime>>();
  private closed = false;

  constructor(
    readonly config: Config,
    readonly log: Logger,
    private readonly options: HubOptions = {},
  ) {
    const offline = config.mode === "offline";
    this.catalog = createModelCatalog({
      provider: offline ? "faux" : "openrouter",
      jobs: config.models,
      installFaux: (models, modelIds) =>
        installScriptedFaux(models, options.fauxRules ?? [], {
          modelIds,
          tokensPerSecond: options.fauxTokensPerSecond,
        }),
    });
    this.jev = offline
      ? new JevClient({ provider: "mock" })
      : new JevClient({ provider: "openrouter", apiKey: config.openrouterKey, model: config.jevModel });
  }

  get providers() {
    return { models: this.catalog.provider, jev: this.jev.provider };
  }

  /** Slugs the hub serves. */
  slugs(): string[] {
    return [DEFAULT_PROJECT];
  }

  async project(slug: string): Promise<ProjectRuntime> {
    if (this.closed) throw new Error("The hub is closing");
    if (!this.slugs().includes(slug)) throw notFound(`No project "${slug}"`);
    let opening = this.opening.get(slug);
    if (!opening) {
      opening = openProject({
        slug,
        dataDir: this.config.dataDir,
        promptsDir: this.config.promptsDir,
        catalog: this.catalog,
        jev: this.jev,
        log: this.log,
        extensions: this.options.extensions,
        deskTools: this.options.deskTools,
      });
      opening.catch(() => this.opening.delete(slug));
      this.opening.set(slug, opening);
    }
    return opening;
  }

  async close(): Promise<void> {
    this.closed = true;
    const open = [...this.opening.values()];
    this.opening.clear();
    for (const p of open) await (await p.catch(() => undefined))?.close();
  }
}
