<script setup lang="ts">
// Settings → Under the hood (spec feature-profiles: Core tab bar): in the core profile, the tabs kept out of the tab
// bar (runs, digest, plugins, and those of advanced features that are on). Each still opens by its address.
import { usePlugins } from "../stores/plugins.ts";

const plugins = usePlugins();
</script>

<template>
  <section v-if="plugins.hiddenTabs.length" class="under-the-hood">
    <h2>Under the hood</h2>
    <p class="muted">What the hub does behind the feed: its runs, the weekly digest, the plugins and more.</p>
    <ul>
      <li v-for="t in plugins.hiddenTabs" :key="t.id">
        <router-link :to="`/${t.id}`" :data-tab="t.id">{{ t.title }}</router-link>
      </li>
    </ul>
  </section>
</template>

<style scoped>
ul {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  padding: 0;
  list-style: none;
}
</style>
