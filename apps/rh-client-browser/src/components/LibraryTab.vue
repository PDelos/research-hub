<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ago, type KbNote, type KbPaper, type KbSearchHit } from "@rh/sdk";
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

async function open(stem: string | null) {
  if (!stem) return;
  try {
    note.value = await client.kbNote(stem);
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
          @click="open(p.stem)"
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
    </article>
    <div v-else class="note empty muted">Choose a paper to read its note.</div>
  </div>
</template>
