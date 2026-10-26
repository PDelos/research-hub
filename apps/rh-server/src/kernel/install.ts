// Installing and uninstalling plugins (spec plugin-system: Install and uninstall; design D7). Installing is two
// steps: prepare copies the plugin (from a folder, or a git URL with isomorphic-git) into a staging folder and
// validates it, returning what it contributes and the permissions it asks for; nothing changes until the user
// approves and confirm moves it into data/plugins/installed/<id> and commits the lockfile. Uninstalling keeps the
// plugin's storage and tables unless the user asks to delete them, so a reinstall picks them up again.
import { randomUUID } from "node:crypto";
import fs, { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import { tablePrefix } from "./api.ts";
import { contributionProblems, contributionsOf, type Contributions } from "./contributions.ts";
import type { PluginKernel } from "./lifecycle.ts";
import {
  engineProblem,
  loadManifest,
  ManifestInvalid,
  type PluginManifest,
  type PluginPermissions,
} from "./manifest.ts";
import type { Discovery } from "./registry.ts";
import { hashFolder, type Actor, type PluginSource, type PluginState } from "./state.ts";

export type InstallSource = { folder: string } | { git: string; ref?: string };

export interface InstallPlan {
  /** Pass to confirm() after the user approves. */
  planId: string;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  /** The version this install replaces, if the plugin is installed already. */
  replaces?: string;
  source: PluginSource;
  permissions: PluginPermissions;
  contributions: Contributions;
}

export class InstallRefused extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}: ${problems.join("; ")}` : message);
    this.name = "InstallRefused";
  }
}

export class PluginInstaller {
  private readonly plans = new Map<string, { plan: InstallPlan; dir: string; manifest: PluginManifest }>();

  constructor(
    private readonly options: { kernel: PluginKernel; state: PluginState; discovery: Discovery; db: Db; log: Logger },
  ) {}

  private get staging(): string {
    return join(this.options.state.dir, "staging");
  }

  /** Copy and validate a plugin; nothing is installed yet. Throws InstallRefused with the problems. */
  async prepare(source: InstallSource): Promise<InstallPlan> {
    const planId = randomUUID();
    const dir = join(this.staging, planId);
    mkdirSync(dir, { recursive: true });
    let lockSource: PluginSource;
    try {
      if ("folder" in source) {
        const from = resolve(source.folder);
        if (!existsSync(join(from, "rh-plugin.json")))
          throw new InstallRefused(`${source.folder} has no rh-plugin.json`);
        cpSync(from, dir, {
          recursive: true,
          filter: (p) => !/\/(\.git|node_modules)(\/|$)/.test(p.slice(from.length)),
        });
        lockSource = { kind: "folder", path: from };
      } else {
        await git.clone({
          fs,
          http,
          dir,
          url: source.git,
          ...(source.ref ? { ref: source.ref } : {}),
          singleBranch: true,
          depth: 1,
        });
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        lockSource = { kind: "git", url: source.git, ...(source.ref ? { ref: source.ref } : {}) };
      }
      let manifest: PluginManifest;
      try {
        manifest = loadManifest(dir);
      } catch (error) {
        if (error instanceof ManifestInvalid) throw new InstallRefused("the manifest is invalid", error.problems);
        throw error;
      }
      const problems = contributionProblems(manifest, dir);
      if (manifest.required) problems.push("required: only built-in plugins can be required");
      if (manifest.main && !existsSync(join(dir, manifest.main)))
        problems.push(`main: ${manifest.main} does not exist`);
      if (problems.length) throw new InstallRefused("the plugin is invalid", problems);
      const existing = this.options.discovery.plugins.get(manifest.id);
      if (existing?.builtin) throw new InstallRefused(`${manifest.id} is a built-in plugin`);
      const incompatible = engineProblem(manifest);
      if (incompatible) throw new InstallRefused(`${manifest.id} is incompatible`, [incompatible]);
      const plan: InstallPlan = {
        planId,
        id: manifest.id,
        version: manifest.version,
        displayName: manifest.displayName,
        ...(manifest.description ? { description: manifest.description } : {}),
        ...(existing ? { replaces: existing.manifest.version } : {}),
        source: lockSource,
        permissions: manifest.permissions,
        contributions: contributionsOf(manifest),
      };
      this.plans.set(planId, { plan, dir, manifest });
      return plan;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      if (error instanceof InstallRefused) throw error;
      throw new InstallRefused(`could not read the plugin (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Install an approved plan: move it in place, commit the lockfile (enabled) and apply it. */
  async confirm(planId: string, actor: Actor = "user"): Promise<InstallPlan> {
    const entry = this.plans.get(planId);
    if (!entry) throw new InstallRefused("this install was not prepared, or was already confirmed or cancelled");
    this.plans.delete(planId);
    const { plan, dir, manifest } = entry;
    const { kernel, state } = this.options;
    if (this.options.discovery.plugins.has(plan.id)) {
      await kernel.deactivate(plan.id);
      kernel.remove(plan.id);
    }
    const target = join(state.dir, "installed", plan.id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(state.dir, "installed"), { recursive: true });
    renameSync(dir, target);
    const hash = hashFolder(target);
    await state.update(
      (l) => {
        l.plugins[plan.id] = {
          version: plan.version,
          source: plan.source,
          hash,
          enabled: true,
          settings: l.plugins[plan.id]?.settings ?? {},
        };
      },
      `${plan.replaces ? "update" : "install"} ${plan.id} ${plan.version}`,
      actor,
    );
    kernel.add({ manifest, dir: target, builtin: false });
    await kernel.apply();
    this.options.log.info("plugin.installed", { plugin: plan.id, version: plan.version });
    return plan;
  }

  cancel(planId: string): void {
    const entry = this.plans.get(planId);
    if (!entry) return;
    this.plans.delete(planId);
    rmSync(entry.dir, { recursive: true, force: true });
  }

  /** Uninstall an external plugin; its storage folder and tables are kept unless `deleteData`. */
  async uninstall(id: string, options: { deleteData?: boolean; actor?: Actor } = {}): Promise<void> {
    const { kernel, state, discovery } = this.options;
    const plugin = discovery.plugins.get(id);
    if (!plugin) throw new InstallRefused(`${id} is not installed`);
    if (plugin.builtin) throw new InstallRefused(`${id} is built in: it can be disabled, not uninstalled`);
    await kernel.deactivate(id);
    kernel.remove(id);
    rmSync(join(state.dir, "installed", id), { recursive: true, force: true });
    if (options.deleteData) {
      rmSync(join(state.dir, "data", id), { recursive: true, force: true });
      const prefix = tablePrefix(id);
      const tables = this.options.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'")
        .all(`${prefix.replaceAll("_", "\\_")}%`) as { name: string }[];
      for (const t of tables) this.options.db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
      const migrations = this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'plugin_migrations'").get();
      if (migrations) this.options.db.prepare("DELETE FROM plugin_migrations WHERE plugin_id = ?").run(id);
    }
    await state.update(
      (l) => {
        delete l.plugins[id];
      },
      `uninstall ${id}${options.deleteData ? " and delete its data" : ""}`,
      options.actor ?? "user",
    );
    this.options.log.info("plugin.uninstalled", { plugin: id, deletedData: !!options.deleteData });
  }
}
