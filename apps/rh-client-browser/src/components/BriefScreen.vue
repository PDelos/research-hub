<script setup lang="ts">
import { computed, ref } from "vue";
import { act, client, store } from "../store.ts";

const LIMIT = 50_000;
const props = defineProps<{ initial?: string; replacing?: boolean }>();
const emit = defineEmits<{ done: [] }>();
const text = ref(props.initial ?? "");
const sending = ref(false);
const chars = computed(() => [...text.value].length);
const tooLong = computed(() => chars.value > LIMIT);

async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) text.value = await file.text();
}

async function submit() {
  if (!text.value.trim() || tooLong.value || sending.value) return;
  sending.value = true;
  try {
    await act(() => client.setBrief(text.value));
    emit("done");
  } catch {
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <form class="brief" @submit.prevent="submit">
    <h2>{{ replacing ? "Replace the brief" : "What is this project about?" }}</h2>
    <p class="muted">
      Paste or upload a markdown brief: the idea, what you already know, what you want to find out. The research desk
      drafts a charter from it and may ask you a few questions.
      <span v-if="replacing">The approved charter stays in force until you approve the new draft.</span>
    </p>
    <textarea
      v-model="text"
      rows="16"
      placeholder="# My research project&#10;&#10;I want to understand…"
      aria-label="Brief"
    />
    <div class="row">
      <label class="file"
        >Upload .md <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" @change="upload"
      /></label>
      <span class="spacer" />
      <span :class="tooLong ? 'error' : 'muted'"
        >{{ chars.toLocaleString() }} / {{ LIMIT.toLocaleString() }} characters</span
      >
      <button type="submit" class="primary" :disabled="!text.trim() || tooLong || sending">
        {{ sending ? "Saving…" : replacing ? "Replace and redraft" : "Save brief and draft charter" }}
      </button>
    </div>
    <p v-if="store.error" class="error">{{ store.error }}</p>
  </form>
</template>
