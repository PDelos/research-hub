<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { client, store } from "../store.ts";

// The embedded Obsidian (Ignis) on the hub's own origin. Obsidian looks Electron up through the topmost window's
// `require`, so the hub page lends it the frame's own (the frame is same-origin; see the v0.5 design).
const frame = ref<HTMLIFrameElement>();
const ready = ref(false);
const failed = ref("");
const viewer = ref(store.info?.kbViewer);
let poll: ReturnType<typeof setInterval> | undefined;

type ObsidianWindow = Window & { require?: (name: string) => unknown; app?: { workspace?: { layoutReady?: boolean; openLinkText(t: string, s: string): unknown } } };
const win = () => frame.value?.contentWindow as ObsidianWindow | null | undefined;

(window as ObsidianWindow).require = (name: string) => {
  const r = win()?.require;
  if (!r) throw new Error("The knowledge base viewer is not loaded");
  return r(name);
};

const initial = store.kbOpen ? `/kb/?file=${encodeURIComponent(store.kbOpen)}` : "/kb/";
store.kbOpen = undefined;

onMounted(async () => {
  viewer.value = (await client.info()).kbViewer;
  if (viewer.value.state !== "running") return;
  const started = Date.now();
  poll = setInterval(() => {
    if (win()?.app?.workspace?.layoutReady) {
      ready.value = true;
      clearInterval(poll);
    } else if (Date.now() - started > 45_000) {
      failed.value = "Obsidian did not finish loading. Reload the page or check the Runs tab for viewer errors.";
      clearInterval(poll);
    }
  }, 250);
});
onBeforeUnmount(() => poll && clearInterval(poll));

// "Open in knowledge base" from the Library while the viewer is loaded: open the note without reloading.
watch(
  () => store.kbOpen,
  (path) => {
    if (!path) return;
    const ws = win()?.app?.workspace;
    if (ready.value && ws) {
      void ws.openLinkText(path.replace(/\.md$/, ""), "");
      store.kbOpen = undefined;
    } else if (frame.value) {
      frame.value.src = `/kb/?file=${encodeURIComponent(path)}`;
      store.kbOpen = undefined;
    }
  },
);
</script>

<template>
  <div class="kb-tab">
    <div v-if="viewer && viewer.state === 'disabled'" class="empty">
      <h2>The knowledge base viewer is off</h2>
      <p>Set <code>RH_KB_VIEWER=on</code> in the project's <code>.env</code> and restart to read and edit the vault with Obsidian here. The Library tab works either way.</p>
    </div>
    <div v-else-if="viewer && viewer.state !== 'running'" class="empty">
      <h2>The knowledge base viewer is not running</h2>
      <p>{{ viewer.reason ?? viewer.state }}. The Library tab still lists and opens every note.</p>
    </div>
    <template v-else>
      <iframe ref="frame" class="kb-frame" :src="initial" title="Knowledge base" />
      <div v-if="!ready" class="kb-overlay">
        <p v-if="failed" class="error">{{ failed }}</p>
        <p v-else class="muted">Opening the knowledge base…</p>
      </div>
    </template>
  </div>
</template>
