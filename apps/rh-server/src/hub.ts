// The hub: the model catalog, the Jev client and the one research project this container serves. Before the
// project opens it takes ownership of the data directory, so two containers can never share one.
import type { Extension } from "@earendil-works/pi-durable";
import { createModelCatalog, installScriptedFaux, type FauxRule, type ModelCatalog } from "@rh/durable-agent";
import { JevClient } from "@rh/jev";
import { offlineRules } from "./faux-rules.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { acquireOwner, type OwnerLock } from "./owner.ts";
import { openProject, type ProjectRuntime } from "./project.ts";

export interface HubOptions {
  /** Scripted faux replies (offline mode and tests). */
  fauxRules?: FauxRule[];
  fauxTokensPerSecond?: number;
  /** Extra extensions and allowed desk tools (tests). */
  extensions?: Extension[];
  deskTools?: readonly string[];
  /** Ownership heartbeat interval (tests). */
  heartbeatMs?: number;
  /** Start the 60 s scheduler ticker (default true; tests drive scheduler.tick() with a fixed clock). */
  ticker?: boolean;
}

export class Hub {
  readonly catalog: ModelCatalog;
  readonly jev: JevClient;
  readonly startedAt = Date.now();
  private opened?: ProjectRuntime;
  private owner?: OwnerLock;

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
        installScriptedFaux(models, options.fauxRules ?? offlineRules, {
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

  get name(): string {
    return this.config.projectName;
  }

  /** Take ownership of the data directory and open the project. Throws DataDirOwned if another container owns it. */
  async open(): Promise<ProjectRuntime> {
    if (this.opened) return this.opened;
    this.owner = acquireOwner(this.config.dataDir, this.name, { heartbeatMs: this.options.heartbeatMs });
    try {
      this.opened = await openProject({
        name: this.name,
        dataDir: this.config.dataDir,
        promptsDir: this.config.promptsDir,
        catalog: this.catalog,
        jev: this.jev,
        log: this.log,
        extensions: this.options.extensions,
        deskTools: this.options.deskTools,
        schedule: this.config.schedule,
      });
      if (this.options.ticker !== false) this.opened.scheduler.start();
    } catch (error) {
      this.owner.release();
      this.owner = undefined;
      throw error;
    }
    return this.opened;
  }

  /** The open project; only valid after open(). */
  get project(): ProjectRuntime {
    if (!this.opened) throw new Error("The project is not open");
    return this.opened;
  }

  async close(): Promise<void> {
    const project = this.opened;
    this.opened = undefined;
    try {
      await project?.close();
    } finally {
      this.owner?.release();
      this.owner = undefined;
    }
  }
}
