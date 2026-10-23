<script setup lang="ts">
import { onMounted, ref } from "vue";
import AgentColumn from "./components/AgentColumn.vue";
import FeedPlaceholder from "./components/FeedPlaceholder.vue";
import RunsView from "./components/RunsView.vue";
import TopBar from "./components/TopBar.vue";
import { connect } from "./store.ts";

const tab = ref<"feed" | "runs">("feed");
onMounted(() => void connect());
</script>

<template>
  <div class="app">
    <TopBar />
    <main class="split">
      <section class="left">
        <nav class="tabs" role="tablist">
          <button role="tab" :aria-selected="tab === 'feed'" :class="{ on: tab === 'feed' }" @click="tab = 'feed'">Feed</button>
          <button role="tab" :aria-selected="tab === 'runs'" :class="{ on: tab === 'runs' }" @click="tab = 'runs'">Runs</button>
        </nav>
        <FeedPlaceholder v-if="tab === 'feed'" />
        <RunsView v-else />
      </section>
      <AgentColumn class="right" />
    </main>
  </div>
</template>
