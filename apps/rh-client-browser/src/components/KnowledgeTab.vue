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

type Leaf = { setViewState(state: { type: string; active?: boolean }): Promise<void> };
type ObsidianWindow = Window & {
  require?: (name: string) => unknown;
  app?: {
    workspace?: {
      layoutReady?: boolean;
      openLinkText(t: string, s: string): unknown;
      getLeaf(newLeaf?: boolean): Leaf;
    };
  };
};
const win = () => frame.value?.contentWindow as ObsidianWindow | null | undefined;

(window as ObsidianWindow).require = (name: string) => {
  const r = win()?.require;
  if (!r) throw new Error("The knowledge base viewer is not loaded");
  return r(name);
};

// The vault index is the first note shown, unless "Open in knowledge base" asked for another.
// The knowledge base opens as a graph (papers, concepts and questions), unless a note was asked for.
const askedFor = store.kbOpen;
const initial = askedFor ? `/kb/?file=${encodeURIComponent(askedFor)}` : "/kb/";
store.kbOpen = undefined;
const view = ref<"graph" | "note">(askedFor ? "note" : "graph");

async function showGraph() {
  const ws = win()?.app?.workspace;
  if (!ws) return;
  await ws.getLeaf(false).setViewState({ type: "graph", active: true });
  view.value = "graph";
}

/** On first load Obsidian may still restore its last note after it reports ready; make sure the graph wins. */
async function graphOnLoad() {
  for (let i = 0; i < 4 && view.value === "graph"; i++) {
    const active = (
      win()?.app?.workspace as { activeLeaf?: { view?: { getViewType?(): string } } } | undefined
    )?.activeLeaf?.view?.getViewType?.();
    if (active !== "graph") await showGraph();
    await new Promise((r) => setTimeout(r, 600));
  }
}

function showIndex() {
  const ws = win()?.app?.workspace;
  if (!ws) return;
  void ws.openLinkText("index", "");
  view.value = "note";
}

onMounted(async () => {
  viewer.value = (await client.info()).kbViewer;
  if (viewer.value.state !== "running") return;
  const started = Date.now();
  poll = setInterval(() => {
    if (win()?.app?.workspace?.layoutReady) {
      ready.value = true;
      clearInterval(poll);
      if (view.value === "graph") void graphOnLoad();
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
      view.value = "note";
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
      <p>
        Set <code>RH_KB_VIEWER=on</code> in the project's <code>.env</code> and restart to read and edit the vault with
        Obsidian here. The Library tab works either way.
      </p>
    </div>
    <div v-else-if="viewer && viewer.state !== 'running'" class="empty">
      <h2>The knowledge base viewer is not running</h2>
      <p>{{ viewer.reason ?? viewer.state }}. The Library tab still lists and opens every note.</p>
    </div>
    <template v-else>
      <div class="kb-bar">
        <button :class="['ghost', { on: view === 'graph' }]" :disabled="!ready" @click="showGraph">Graph</button>
        <button :class="['ghost', { on: view === 'note' }]" :disabled="!ready" @click="showIndex">Index</button>
        <span class="muted small kb-legend"
          ><i class="kb-dot kb-dot-papers" /> papers <i class="kb-dot kb-dot-concepts" /> concepts
          <i class="kb-dot kb-dot-questions" /> questions</span
        >
      </div>
      <iframe ref="frame" class="kb-frame" :src="initial" title="Knowledge base" />
      <div v-if="!ready" class="kb-overlay">
        <p v-if="failed" class="error">{{ failed }}</p>
        <p v-else class="muted">Opening the knowledge base…</p>
      </div>
    </template>
  </div>
</template>
