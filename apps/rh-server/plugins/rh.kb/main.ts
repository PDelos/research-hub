// Built-in plugin rh.kb: the vault, its search index, the librarian (ingest of ⭐ papers) and the KB chat tools.
// It offers kb.viewer: viewer plugins register an implementation, and the active contribution (setting kb.viewer)
// is shown while the others are paused, switching live when the setting changes.
import { dirname, join } from "node:path";
import { Ingest } from "../../src/kb/ingest.ts";
import { KbIndex } from "../../src/kb/search.ts";
import { kbTools } from "../../src/kb/tools.ts";
import { Vault } from "../../src/kb/vault.ts";
import { KbViewer } from "../../src/kb/viewer.ts";
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PointContribution } from "../../src/kernel/contributions.ts";
import type { Disposable, PluginContext } from "../../src/kernel/lifecycle.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { FeedbackExports } from "../rh.feedback/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import type { SweepExports } from "../rh.sweep/main.ts";

/** A viewer plugin's implementation of its kb.viewer contribution. */
export interface ViewerImpl {
  /** The supervised viewer process, when the viewer has one (its status is the project's kbViewer). */
  kbViewer?: KbViewer;
  /** Whether it can run here (an add-on may be missing from the image), and why not. */
  usable(): { ok: boolean; reason?: string };
  show(): void | Promise<void>;
  hide(reason: string): void | Promise<void>;
}

export interface KbExports extends AgentHooks {
  vault: Vault;
  kbIndex: KbIndex;
  ingest: Ingest;
  /** Create the vault and refresh charter.md after a charter approval, then (re)start what depends on it. */
  syncVault(): void;
  registerViewer(id: string, impl: ViewerImpl): Disposable;
  /** The active kb.viewer contribution: the saved choice, else Obsidian when it can run, else the Library. */
  activeViewer(): (PointContribution & { pluginId: string }) | undefined;
  /** The Obsidian viewer's supervisor, or a disabled one saying why there is none. */
  kbViewer(): KbViewer;
}

export function activate(context: PluginContext): KbExports {
  const host = hostOf(context);
  const { options } = host;
  const { catalog } = context.exports["rh.provider-openrouter"] as ProviderExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const { feedback } = context.exports["rh.feedback"] as FeedbackExports;
  const { cards } = context.exports["rh.sweep"] as SweepExports;
  const { contributions } = host.services;

  const vault = new Vault(join(host.dir, "vault"), {
    templateDir: join(dirname(options.promptsDir), "vault-template"),
    settings: host.settings,
    log: host.log,
  });
  /** Create the vault and refresh charter.md once a charter is approved (user edits to charter.md win). */
  const writeVault = () => {
    const approved = charters.approved();
    if (!approved) return;
    vault.ensure();
    vault.writeCharter(approved.charter, approved.version!);
  };
  writeVault();
  const kbIndex = new KbIndex({ db: host.db, vault, log: host.log });
  const ingest = new Ingest({
    db: host.db,
    vault,
    store: papers.store,
    cards,
    feedback,
    charters,
    catalog,
    promptsDir: options.promptsDir,
    log: host.log,
    observe: host.observe,
  });
  // A new ⭐ (or any judgment change) may queue a knowledge-base request.
  context.subscriptions.push({ dispose: feedback.onChange(() => ingest.pickUp()) });

  const viewers = new Map<string, ViewerImpl>();
  let ready = false;
  let fallback: KbViewer | undefined;
  const activeViewer = () => {
    const saved = context.savedSettings["kb.viewer"];
    const automatic = viewers.get("obsidian")?.usable().ok ? "obsidian" : "library";
    return contributions.activeContribution("kb.viewer", { "kb.viewer": saved ?? automatic });
  };
  /** Show the active viewer and pause the others (once the project is ready); one switch at a time. */
  let switching: Promise<void> = Promise.resolve();
  const applyViewer = () => {
    if (!ready) return switching;
    switching = switching.then(async () => {
      await contributions.contributionsTo("kb.viewer", { activate: true });
      const active = activeViewer();
      for (const [id, impl] of viewers)
        // A viewer that cannot run here is still asked to start, so it reports why (e.g. no Ignis in this image).
        if (id === active?.id || !impl.usable().ok) await impl.show();
        else await impl.hide(`the ${active?.title ?? "selected"} viewer is active`);
    });
    switching = switching.catch((error) => context.log.warn("kb.viewer_switch_failed", { error: String(error) }));
    return switching;
  };
  context.onSettingsChange(() => applyViewer());

  return {
    vault,
    kbIndex,
    ingest,
    syncVault() {
      writeVault();
      kbIndex.start();
      ingest.pickUp();
      void applyViewer();
    },
    registerViewer(id, impl) {
      viewers.set(id, impl);
      // A viewer enabled while the project runs is shown or paused at once.
      void applyViewer();
      return { dispose: () => void (viewers.get(id) === impl && viewers.delete(id)) };
    },
    activeViewer,
    kbViewer() {
      const own = viewers.get("obsidian")?.kbViewer;
      if (own) return own;
      fallback ??= new KbViewer({
        enabled: false,
        disabledReason:
          options.kbViewer?.enabled === false ? "RH_KB_VIEWER=off" : "the Obsidian viewer plugin is disabled",
        ignisDir: options.kbViewer?.dir ?? "/opt/ignis",
        stateDir: join(host.dir, "kb-viewer"),
        vaultDir: vault.dir,
        projectName: host.name,
        obsidianVersion: options.kbViewer?.obsidianVersion ?? "1.14.4",
        offline: options.offline,
        log: host.log,
      });
      return fallback;
    },
    agentExtensions: [kbTools(() => ({ vault, index: kbIndex }))],
    separateExtensions: [ingest.extension],
    attach: (harness, ctx) => ingest.attach(harness, ctx),
    ready() {
      ingest.pickUp();
      kbIndex.start();
      ready = true;
      void applyViewer();
    },
  };
}
