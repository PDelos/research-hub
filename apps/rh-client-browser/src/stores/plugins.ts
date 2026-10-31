// The plugins store (Pinia): what the enabled plugins contribute (tabs, the knowledge-base viewer, settings) and the
// plugin list. The stream's `plugins` frame refreshes it, so tabs follow enable and disable without a reload.
import { defineStore } from "pinia";
import type { PluginContributionsView, PluginHistoryEntry, PluginSummary } from "@rh/sdk";
import { client, store } from "../store.ts";

/** The tabs the core profile shows in the tab bar; the others are under "Under the hood" in Settings (v2.0). */
export const CORE_TABS = ["feed", "digest", "library", "charter", "settings"];
const inCore = () => store.info?.profile === "core";

/** Which plugins could run: when it changes, so may the tabs, the viewer choice and the settings. */
function availability(list: PluginSummary[]): string {
  return list.map((p) => `${p.id}:${["disabled", "blocked", "incompatible"].includes(p.state) ? 0 : 1}`).join();
}

export const usePlugins = defineStore("plugins", {
  state: () => ({
    contributions: undefined as PluginContributionsView | undefined,
    plugins: [] as PluginSummary[],
    kernelApi: "",
    invalid: [] as { dir: string; problems: string[] }[],
    history: [] as PluginHistoryEntry[],
    error: "",
  }),
  getters: {
    /** Every tab the enabled plugins contribute; each opens by its URL. */
    allTabs: (s) => s.contributions?.tabs ?? [],
    /** The tab bar: in the core profile only Feed, Digest, Library, Charter and Settings, in that order. */
    tabs: (state) => {
      const all = state.contributions?.tabs ?? [];
      if (!inCore()) return all;
      return CORE_TABS.flatMap((id) => all.filter((t) => t.id === id));
    },
    /** In the core profile, the tabs left out of the tab bar (Settings lists them under "Under the hood"). */
    hiddenTabs: (s) => (inCore() ? (s.contributions?.tabs ?? []).filter((t) => !CORE_TABS.includes(t.id)) : []),
    viewer: (s) => s.contributions?.viewer.active ?? null,
  },
  actions: {
    async refresh() {
      try {
        const [contributions, list] = await Promise.all([client.contributions(), client.plugins()]);
        this.contributions = contributions;
        this.plugins = list.plugins;
        this.kernelApi = list.kernelApi;
        this.invalid = list.invalid;
        this.error = "";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    },
    async loadHistory() {
      this.history = await client.pluginHistory(200);
    },
    /** States from the stream; contributions follow when the set of available plugins changed. */
    applyFrame(plugins: PluginSummary[]) {
      const changed = availability(plugins) !== availability(this.plugins);
      this.plugins = plugins;
      if (changed || !this.contributions) void this.refresh();
    },
  },
});
