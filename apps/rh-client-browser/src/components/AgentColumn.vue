<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { k } from "@rh/sdk";
import { send, store, transcript } from "../store.ts";

const draft = ref("");
const sending = ref(false);
const scroller = ref<HTMLElement>();

watch(
  () => transcript.value.items,
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

async function submit() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  try {
    await send(text);
    draft.value = "";
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  } finally {
    sending.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
}
</script>

<template>
  <aside class="agent">
    <div class="agent-head">
      <span class="title">Research desk</span>
      <span class="muted">{{ store.agent?.model ?? "" }}</span>
      <span class="spacer" />
      <span class="muted" v-if="store.agent"
        >{{ k(store.agent.contextTokens) }} / {{ k(store.agent.contextWindow) }} context</span
      >
    </div>
    <div class="transcript" ref="scroller" aria-live="polite">
      <p v-if="transcript.ready && !transcript.items.length" class="muted center">Say hello to the research desk.</p>
      <template v-for="item in transcript.items" :key="`${item.kind}-${item.id}`">
        <div v-if="item.kind === 'user'" class="msg user">{{ item.text }}</div>
        <div v-else-if="item.kind === 'assistant'" class="msg assistant" :class="{ streaming: item.streaming }">
          <template v-for="(block, i) in item.blocks" :key="i">
            <div v-if="block.type === 'text'" class="text">{{ block.text }}</div>
            <div v-else-if="block.type === 'tool'" class="tool">
              <span class="tool-name">{{ block.call.name }}</span>
              <span class="muted">{{ block.call.status }}</span>
            </div>
          </template>
          <div v-if="item.error" class="note">{{ item.error }}</div>
        </div>
        <div v-else-if="item.kind === 'event'" class="event muted">{{ item.text }}</div>
      </template>
      <div v-if="transcript.running && !transcript.generating" class="muted typing">Working…</div>
    </div>
    <form class="composer" @submit.prevent="submit">
      <textarea
        v-model="draft"
        rows="2"
        placeholder="Message the research desk"
        aria-label="Message"
        @keydown="onKey"
      />
      <button type="submit" :disabled="!draft.trim() || sending">Send</button>
    </form>
  </aside>
</template>
