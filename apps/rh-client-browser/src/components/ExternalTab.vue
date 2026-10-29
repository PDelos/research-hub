<script setup lang="ts">
// A tab contributed by an external plugin (spec plugin-system; design D5): its browser module defines a custom
// element named by the tab's view; it gets the hub client (through the UI proxy) and inherits the hub's CSS tokens.
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginTabView } from "@rh/sdk";
import { client } from "../store.ts";

const props = defineProps<{ tab: PluginTabView }>();
const host = ref<HTMLElement>();
const error = ref("");

onMounted(async () => {
  try {
    await import(/* @vite-ignore */ props.tab.script!);
    if (!customElements.get(props.tab.view))
      throw new Error(`${props.tab.pluginId} did not define <${props.tab.view}>`);
    const element = document.createElement(props.tab.view) as HTMLElement & { rhClient?: unknown; rhPlugin?: string };
    element.rhClient = client;
    element.rhPlugin = props.tab.pluginId;
    host.value?.replaceChildren(element);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  }
});
onBeforeUnmount(() => host.value?.replaceChildren());
</script>

<template>
  <div class="external-tab">
    <p v-if="error" class="error">This tab could not load: {{ error }}</p>
    <div ref="host" class="external-host" :data-plugin="tab.pluginId" />
  </div>
</template>
