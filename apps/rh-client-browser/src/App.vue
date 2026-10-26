<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AgentColumn from "./components/AgentColumn.vue";
import BriefScreen from "./components/BriefScreen.vue";
import CharterTab from "./components/CharterTab.vue";
import DigestTab from "./components/DigestTab.vue";
import ExternalTab from "./components/ExternalTab.vue";
import FeedView from "./components/FeedView.vue";
import KnowledgeTab from "./components/KnowledgeTab.vue";
import LibraryTab from "./components/LibraryTab.vue";
import PluginsTab from "./components/PluginsTab.vue";
import RunsView from "./components/RunsView.vue";
import SettingsTab from "./components/SettingsTab.vue";
import TopBar from "./components/TopBar.vue";
import { client, connect, onPlugins, store } from "./store.ts";
import { usePlugins } from "./stores/plugins.ts";

// Built-in views by the id plugins name in their tab contributions; external plugins bring custom elements.
const views = {
  feed: FeedView,
  digest: DigestTab,
  library: LibraryTab,
  charter: CharterTab,
  runs: RunsView,
  settings: SettingsTab,
  plugins: PluginsTab,
} as const;

const plugins = usePlugins();
const route = useRoute();
const router = useRouter();
const tab = computed(() => String(route.params.tab ?? "feed"));
const current = computed(() => plugins.tabs.find((t) => t.id === tab.value));
const go = (id: string) => void router.replace(`/${id}`);
// A tab whose plugin was disabled (or an old link) falls back to the first tab.
watch([() => plugins.contributions, tab], () => {
  if (plugins.contributions && !current.value && plugins.tabs.length) go(plugins.tabs[0].id);
});
const needsBrief = computed(() => store.project?.status === "needs-brief");
// The Knowledge base tab shows the active kb.viewer: Obsidian stays mounted once opened (no reloads on tab switch).
const kbView = computed(() => plugins.viewer?.view ?? "kb-obsidian");
const kbMounted = ref(false);
watch(
  [tab, kbView],
  ([t, v]) => {
    if (t === "kb" && v === "kb-obsidian") kbMounted.value = true;
    if (v !== "kb-obsidian") kbMounted.value = false;
  },
  { immediate: true },
);
// Opening a tab fires onView:<tab> once per session, so plugins that wait for their view start then.
const opened = new Set<string>();
watch(
  tab,
  (t) => {
    if (opened.has(t)) return;
    opened.add(t);
    void client.openView(t).catch(() => opened.delete(t));
  },
  { immediate: true },
);
watch(
  () => store.kbOpen,
  (path) => path && go("kb"),
);
onMounted(() => {
  onPlugins((list) => plugins.applyFrame(list));
  void plugins.refresh();
  void connect();
});
</script>

<template>
  <div class="app">
    <TopBar />
    <main class="split">
      <section class="left">
        <BriefScreen v-if="needsBrief" @done="go('charter')" />
        <template v-else>
          <nav class="tabs" role="tablist">
            <button
              v-for="t in plugins.tabs"
              :key="t.id"
              role="tab"
              :aria-selected="tab === t.id"
              :class="{ on: tab === t.id }"
              :data-plugin="t.pluginId"
              @click="go(t.id)"
            >
              {{ t.title }}<span v-if="t.id === 'charter' && store.project?.status === 'charter-review'" class="pip" />
            </button>
          </nav>
          <KnowledgeTab v-if="kbMounted" v-show="tab === 'kb'" />
          <template v-if="current && tab !== 'kb'">
            <component
              :is="views[current.view as keyof typeof views]"
              v-if="current.builtin && current.view in views"
            />
            <ExternalTab v-else-if="current.script" :key="current.pluginId + current.id" :tab="current" />
            <p v-else class="empty muted">The view {{ current.view }} is not available in this version of the hub.</p>
          </template>
          <LibraryTab v-if="tab === 'kb' && kbView === 'library'" />
          <p v-if="!plugins.contributions && !plugins.error" class="empty muted">Loading…</p>
          <p v-if="plugins.error" class="error">{{ plugins.error }}</p>
        </template>
      </section>
      <AgentColumn class="right" />
    </main>
  </div>
</template>
