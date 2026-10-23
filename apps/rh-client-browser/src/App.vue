<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import AgentColumn from "./components/AgentColumn.vue";
import BriefScreen from "./components/BriefScreen.vue";
import CharterTab from "./components/CharterTab.vue";
import FeedView from "./components/FeedView.vue";
import KnowledgeTab from "./components/KnowledgeTab.vue";
import LibraryTab from "./components/LibraryTab.vue";
import RunsView from "./components/RunsView.vue";
import SettingsTab from "./components/SettingsTab.vue";
import TopBar from "./components/TopBar.vue";
import { connect, store } from "./store.ts";

type Tab = "feed" | "library" | "kb" | "charter" | "runs" | "settings";
const tabs: { id: Tab; label: string }[] = [
  { id: "feed", label: "Feed" },
  { id: "library", label: "Library" },
  { id: "kb", label: "Knowledge base" },
  { id: "charter", label: "Charter" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
];
const fromHash = (): Tab => {
  const id = location.hash.replace("#/", "") as Tab;
  return tabs.some((t) => t.id === id) ? id : "feed";
};
const tab = ref<Tab>(fromHash());
const go = (id: Tab) => {
  tab.value = id;
  history.replaceState(null, "", `#/${id}`);
};
const needsBrief = computed(() => store.project?.status === "needs-brief");
// The knowledge base stays mounted once opened, so switching tabs never reloads Obsidian.
const kbMounted = ref(tab.value === "kb");
watch(tab, (t) => t === "kb" && (kbMounted.value = true));
watch(() => store.kbOpen, (path) => path && go("kb"));
onMounted(() => {
  window.addEventListener("hashchange", () => (tab.value = fromHash()));
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
              v-for="t in tabs"
              :key="t.id"
              role="tab"
              :aria-selected="tab === t.id"
              :class="{ on: tab === t.id }"
              @click="go(t.id)"
            >
              {{ t.label }}<span v-if="t.id === 'charter' && store.project?.status === 'charter-review'" class="pip" />
            </button>
          </nav>
          <KnowledgeTab v-if="kbMounted" v-show="tab === 'kb'" />
          <FeedView v-if="tab === 'feed'" />
          <LibraryTab v-else-if="tab === 'library'" />
          <CharterTab v-else-if="tab === 'charter'" />
          <RunsView v-else-if="tab === 'runs'" />
          <SettingsTab v-else-if="tab === 'settings'" />
        </template>
      </section>
      <AgentColumn class="right" />
    </main>
  </div>
</template>
