<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AgentColumn from "./components/AgentColumn.vue";
import BriefScreen from "./components/BriefScreen.vue";
import CharterTab from "./components/CharterTab.vue";
import FeedPlaceholder from "./components/FeedPlaceholder.vue";
import RunsView from "./components/RunsView.vue";
import SettingsTab from "./components/SettingsTab.vue";
import TopBar from "./components/TopBar.vue";
import { connect, store } from "./store.ts";

type Tab = "feed" | "charter" | "runs" | "settings";
const tabs: { id: Tab; label: string }[] = [
  { id: "feed", label: "Feed" },
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
          <FeedPlaceholder v-if="tab === 'feed'" />
          <CharterTab v-else-if="tab === 'charter'" />
          <RunsView v-else-if="tab === 'runs'" />
          <SettingsTab v-else />
        </template>
      </section>
      <AgentColumn class="right" />
    </main>
  </div>
</template>
