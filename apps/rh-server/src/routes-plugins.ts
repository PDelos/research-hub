// The plugins API (spec plugin-system: Plugins view, Install and uninstall, Plugin settings; design D10): list and
// details without running plugin code, contributions for the tab bar and Settings, install with approval, enable,
// disable, settings, uninstall, history and rollback. External plugins' browser modules are served under /plugins.
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import express, { type Router } from "express";
import type { PluginContributionsView, PluginDetails, PluginInstallSource, PluginList } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { ApiFault, invalid, notFound, optInt } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { contributionsOf } from "./kernel/contributions.ts";
import { dependents } from "./kernel/graph.ts";
import { InstallRefused } from "./kernel/install.ts";
import { HasDependents, PluginUnavailable, SettingsInvalid, UndoRefused } from "./kernel/lifecycle.ts";
import { KERNEL_API_VERSION } from "./kernel/manifest.ts";
import { settingsProperties } from "./kernel/settings.ts";
import type { KbExports } from "../plugins/rh.kb/main.ts";

const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** Kernel errors as API faults (the problems or dependents go in error.details). */
function fault(error: unknown): never {
  if (error instanceof InstallRefused) throw new ApiFault("invalid", error.message, error.problems);
  if (error instanceof SettingsInvalid) throw new ApiFault("invalid", error.message, error.problems);
  if (error instanceof HasDependents)
    throw new ApiFault(
      "conflict",
      `${error.message}: disable them too (cascade) or keep ${error.pluginId}`,
      error.dependents,
    );
  if (error instanceof PluginUnavailable) throw new ApiFault("conflict", error.message);
  if (error instanceof UndoRefused) throw new ApiFault("conflict", error.message);
  throw error;
}

export function pluginRoutes(hub: Hub): Router {
  const router = express.Router();
  const host = () => hub.project.plugins;

  // External plugins' UI modules (public like the UI's own assets): only files beside the manifest's `browser` entry.
  router.get(/^\/plugins\/([a-z0-9.-]+)\/(.+)$/, (request, response, next) => {
    const [id, path] = [request.params[0] as string, request.params[1] as string];
    const plugin = hub.current?.plugins.discovery.plugins.get(id);
    const state = hub.current?.plugins.kernel.get(id)?.state;
    if (!plugin?.manifest.browser || plugin.builtin || state === "disabled" || state === "incompatible") return next();
    const root = resolve(plugin.dir, dirname(plugin.manifest.browser));
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || !existsSync(file)) return next();
    response.set("cache-control", "no-cache").sendFile(file);
  });

  router.use("/v1", requireAuth(hub.log));

  const pluginId = (raw: unknown) => {
    const id = String(raw);
    if (!ID.test(id)) throw invalid("plugin id must look like publisher.name");
    if (!host().discovery.plugins.has(id)) throw notFound(`No plugin ${id}`);
    return id;
  };

  const list = (): PluginList => ({
    kernelApi: KERNEL_API_VERSION,
    plugins: host().kernel.list(),
    invalid: host().discovery.invalid.map((i) => ({
      dir: relative(hub.config.dataDir, i.dir) || i.dir,
      problems: i.problems,
    })),
  });

  const details = async (id: string): Promise<PluginDetails> => {
    const { kernel, discovery, contributions, state } = host();
    const plugin = discovery.plugins.get(id)!;
    const { manifest } = plugin;
    const c = contributionsOf(manifest);
    const lock = state.current();
    const nodes = new Map(
      [...discovery.plugins].map(([pid, p]) => [
        pid,
        { manifest: p.manifest, enabled: lock.plugins[pid]?.enabled ?? false },
      ]),
    );
    const history = (await state.history(200)).filter((h) => h.message.split(/[\s,]+/).includes(id));
    return {
      ...kernel.get(id)!,
      engines: manifest.engines["research-hub"],
      activationEvents: manifest.activationEvents,
      dependencies: manifest.dependencies,
      dependents: dependents(nodes, id).filter((d) => lock.plugins[d]?.enabled),
      required: !!(plugin.builtin && manifest.required),
      permissions: manifest.permissions,
      contributions: {
        tabs: c.tabs,
        commands: c.commands,
        chatTools: c.chatTools.map(({ name, description, desk }) => ({
          name,
          description,
          ...(desk === undefined ? {} : { desk }),
        })),
        jevCommands: c.jevCommands.map((p) => p.split("/").at(-1)!),
        prompts: c.prompts,
        processes: c.processes,
        extensionPoints: Object.fromEntries(
          Object.entries(c.extensionPoints).map(([k, v]) => [
            k,
            {
              cardinality: v.cardinality,
              ...(v.description ? { description: v.description } : {}),
              ...(v.default ? { default: v.default } : {}),
            },
          ]),
        ),
        points: c.points,
      },
      settings: { properties: settingsProperties(manifest), values: kernel.settings(id) },
      problems: contributions.problems(id),
      history,
    };
  };

  router.get("/v1/plugins", (_request, response) => void response.json(list()));

  router.get("/v1/plugins/contributions", async (_request, response) => {
    const { kernel, contributions, discovery } = host();
    const viewers = contributions.extensionPoints().has("kb.viewer")
      ? (await host().exportsOf<KbExports>("rh.kb")).activeViewer()
      : undefined;
    const options = [...discovery.plugins.values()].flatMap((p) =>
      kernel.available().includes(p.manifest.id)
        ? (contributionsOf(p.manifest).points["kb.viewer"] ?? []).map((v) => ({
            id: v.id,
            title: String(v.title ?? v.id),
            pluginId: p.manifest.id,
          }))
        : [],
    );
    const view: PluginContributionsView = {
      tabs: contributions.tabs().map((t) => {
        const plugin = discovery.plugins.get(t.pluginId)!;
        return {
          id: t.id,
          title: t.title,
          view: t.view,
          ...(t.order === undefined ? {} : { order: t.order }),
          pluginId: t.pluginId,
          builtin: plugin.builtin,
          ...(!plugin.builtin && plugin.manifest.browser
            ? { script: `/plugins/${t.pluginId}/${plugin.manifest.browser.split("/").at(-1)}` }
            : {}),
        };
      }),
      viewer: {
        active: viewers
          ? {
              id: viewers.id,
              title: String(viewers.title ?? viewers.id),
              view: String(viewers.view ?? viewers.id),
              pluginId: viewers.pluginId,
            }
          : null,
        options,
      },
      settings: kernel
        .available()
        .map((id) => discovery.plugins.get(id)!)
        .filter((p) => Object.keys(settingsProperties(p.manifest)).length)
        .map((p) => ({
          pluginId: p.manifest.id,
          displayName: p.manifest.displayName,
          properties: settingsProperties(p.manifest),
          values: kernel.settings(p.manifest.id),
        })),
    };
    response.json(view);
  });

  // The UI opened a tab: plugins waiting for onView:<tab> start now (lazy activation).
  router.post("/v1/plugins/views/:tab/open", async (request, response) => {
    const tab = String(request.params.tab);
    if (!/^[a-z0-9-]+$/.test(tab)) throw invalid("tab must be a tab id");
    await host().kernel.fire(`onView:${tab}`);
    response.status(204).end();
  });

  router.get("/v1/plugins/history", async (request, response) => {
    const limit = Math.min(500, Math.max(1, optInt(request.query.limit, "limit") ?? 100));
    response.json(await host().state.history(limit));
  });

  router.post("/v1/plugins/rollback", async (request, response) => {
    const commit = request.body?.commit;
    if (typeof commit !== "string" || !/^[0-9a-f]{4,40}$/.test(commit))
      throw invalid("commit must be a commit id from the history");
    try {
      await host().kernel.rollback(commit);
    } catch (error) {
      if (error instanceof Error && /not found|could not find/i.test(error.message))
        throw notFound(`No commit ${commit}`);
      throw error;
    }
    response.json(list());
  });

  // Undo one change from the history; later changes stay (refused when a later change touched the same thing).
  router.post("/v1/plugins/undo", async (request, response) => {
    const commit = request.body?.commit;
    if (typeof commit !== "string" || !/^[0-9a-f]{4,40}$/.test(commit))
      throw invalid("commit must be a commit id from the history");
    const result = await host().kernel.undo(commit).catch(fault);
    response.json({ commit: result.id ?? null, plugins: result.plugins, history: await host().state.history(20) });
  });

  router.post("/v1/plugins/install", async (request, response) => {
    const source = request.body?.source as PluginInstallSource | undefined;
    const ok =
      source &&
      (("folder" in source && typeof source.folder === "string" && source.folder.length > 0) ||
        ("git" in source && typeof source.git === "string" && /^https?:\/\//.test(source.git)));
    if (!ok) throw invalid('source must be {"folder": "<path on the server>"} or {"git": "https://…"}');
    response.json(await host().installer.prepare(source).catch(fault));
  });

  router.post("/v1/plugins/install/:planId/approve", async (request, response) => {
    const plan = await host().installer.confirm(String(request.params.planId)).catch(fault);
    response.json(await details(plan.id));
  });

  router.delete("/v1/plugins/install/:planId", (request, response) => {
    host().installer.cancel(String(request.params.planId));
    response.status(204).end();
  });

  router.get(
    "/v1/plugins/:id",
    async (request, response) => void response.json(await details(pluginId(request.params.id))),
  );

  for (const action of ["enable", "disable"] as const)
    router.post(`/v1/plugins/:id/${action}`, async (request, response) => {
      const id = pluginId(request.params.id);
      await host()
        .kernel.setEnabled(id, action === "enable", { cascade: request.body?.cascade === true })
        .catch(fault);
      response.json(await details(id));
    });

  router.put("/v1/plugins/:id/settings", async (request, response) => {
    const id = pluginId(request.params.id);
    const values = request.body?.values;
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw invalid("values must be an object of settings");
    const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? undefined : v]));
    await host().kernel.configure(id, changes).catch(fault);
    response.json(await details(id));
  });

  router.delete("/v1/plugins/:id", async (request, response) => {
    const id = pluginId(request.params.id);
    await host()
      .installer.uninstall(id, { deleteData: request.query.deleteData === "true" })
      .catch(fault);
    response.status(204).end();
  });

  return router;
}
