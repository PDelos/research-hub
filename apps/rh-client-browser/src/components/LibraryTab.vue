<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ago, isRhError, type FullTextView, type KbNote, type KbPaper, type KbSearchHit } from "@rh/sdk";
import { client, openInKb, store } from "../store.ts";
import { renderMarkdown } from "../markdown.ts";

const papers = ref<KbPaper[]>([]);
const note = ref<KbNote>();
const query = ref("");
const hits = ref<KbSearchHit[] | undefined>();

async function load() {
  try {
    papers.value = await client.kbPapers();
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

// The paper's full text (v1.6): where it came from and its sections.
const fullText = ref<FullTextView>();
const fetching = ref(false);
const fullTextError = ref("");
const SOURCE: Record<string, string> = {
  "arxiv-html": "arXiv HTML",
  "europepmc-jats": "Europe PMC XML",
  "biorxiv-jats": "bioRxiv XML",
};
const sourceName = (s: string | null) =>
  !s ? "" : (SOURCE[s] ?? (s.startsWith("pdf:") ? `PDF via the ${s.slice(4)} converter` : s));
async function loadFullText(paperId: number) {
  fullTextError.value = "";
  try {
    fullText.value = await client.fullText(paperId);
  } catch {
    fullText.value = undefined;
  }
}
async function getFullText() {
  if (!fullText.value) return;
  fetching.value = true;
  fullTextError.value = "";
  try {
    fullText.value = await client.fetchFullText(fullText.value.paperId);
  } catch (e) {
    fullTextError.value = isRhError(e) ? e.message : String(e);
  } finally {
    fetching.value = false;
  }
}

async function open(stem: string | null, paperId?: number) {
  if (!stem) return;
  try {
    note.value = await client.kbNote(stem);
    const id = paperId ?? papers.value.find((p) => p.stem === stem)?.paperId;
    if (id !== undefined) await loadFullText(id);
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }
}

async function search() {
  hits.value = query.value.trim() ? await client.kbSearch(query.value.trim()) : undefined;
}

/** Wikilinks inside a rendered note open that note here. */
function follow(event: MouseEvent) {
  const a = (event.target as HTMLElement).closest("a.wikilink") as HTMLElement | null;
  if (a?.dataset.stem) {
    event.preventDefault();
    void open(a.dataset.stem);
  }
}

const shown = (v: unknown) =>
  Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? "");
const HIDDEN = new Set(["title"]);
</script>

<template>
  <div class="library">
    <div class="library-list">
      <form class="kb-search" @submit.prevent="search">
        <input
          v-model="query"
          type="search"
          placeholder="Search the knowledge base…"
          aria-label="Search the knowledge base"
        />
      </form>
      <template v-if="hits">
        <h3 class="section">Search results</h3>
        <ul class="kb-items">
          <li v-for="h in hits" :key="h.path" @click="open(h.stem)">
            <strong>{{ h.title }}</strong>
            <span class="muted small">{{ h.path }}</span>
            <span class="excerpt" v-html="renderMarkdown(h.excerpt)" />
          </li>
          <li v-if="!hits.length" class="muted static">Nothing matches.</li>
        </ul>
      </template>
      <h3 class="section">Papers in the knowledge base</h3>
      <ul class="kb-items">
        <li
          v-for="p in papers"
          :key="p.paperId"
          :class="{ sel: note && note.stem === p.stem, static: !p.stem }"
          @click="open(p.stem, p.paperId)"
        >
          <strong>{{ p.title }}</strong>
          <span class="muted small">
            <span v-if="p.level" class="badge level">{{ p.level }}</span>
            {{ p.year ?? "" }} {{ p.venue ? `· ${p.venue}` : "" }} · added {{ ago(p.addedAt) }}
            <span v-if="p.status === 'pending'"> · being written…</span>
            <span v-else-if="p.status === 'failed'" class="error"> · failed: {{ p.statusReason }}</span>
          </span>
          <span v-if="p.reason" class="muted small">“{{ p.reason }}”</span>
        </li>
        <li v-if="!papers.length" class="muted static">No papers yet. Star a card (⭐) in the Feed to add it.</li>
      </ul>
    </div>
    <article v-if="note" class="note" @click="follow">
      <header class="note-head">
        <h2>{{ note.properties.title ?? note.stem }}</h2>
        <button class="ghost" @click.stop="openInKb(note.path)">Open in knowledge base</button>
      </header>
      <table v-if="Object.keys(note.properties).length" class="props">
        <tr v-for="(v, k) in note.properties" v-show="!HIDDEN.has(String(k))" :key="k">
          <th>{{ k }}</th>
          <td>{{ shown(v) }}</td>
        </tr>
      </table>
      <div class="note-body" v-html="renderMarkdown(note.body)" />
      <section v-if="fullText" class="fulltext" data-test="fulltext" @click.stop>
        <div class="row">
          <h3>Full text</h3>
          <span class="spacer" />
          <button class="ghost small" :disabled="fetching" @click="getFullText">
            {{ fetching ? "Getting…" : fullText.status === "ok" ? "Get again" : "Get full text" }}
          </button>
        </div>
        <p v-if="fullTextError" class="error small">{{ fullTextError }}</p>
        <p v-if="fullText.status === 'ok'" class="muted small">
          From {{ sourceName(fullText.source) }} · {{ fullText.sections.length }} sections ·
          {{ fullText.chars < 1000 ? fullText.chars : `${Math.round(fullText.chars / 1000)}k` }} characters
        </p>
        <p v-else-if="fullText.status === 'missing'" class="muted small">Not found: {{ fullText.notes.join("; ") }}</p>
        <p v-else class="muted small">Not fetched yet.</p>
        <details v-for="(s, i) in fullText.sections" :key="i">
          <summary>{{ s.title }}</summary>
          <p class="small fulltext-section">{{ s.text }}</p>
        </details>
      </section>
    </article>
    <div v-else class="note empty muted">Choose a paper to read its note.</div>
  </div>
</template>
