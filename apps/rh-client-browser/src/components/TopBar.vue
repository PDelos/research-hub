<script setup lang="ts">
import { computed } from "vue";
import { usd } from "@rh/sdk";
import { act, client, store } from "../store.ts";

const mode = computed(() => store.info?.mode ?? "…");
const status = computed(() => store.project?.status);
const nextSweep = computed(() => {
  const at = store.project?.next.sweep;
  if (!at) return "";
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
});
const pause = () => act(() => client.pause());
const resume = () => act(() => client.resume());
const label: Record<string, string> = {
  "needs-brief": "needs a brief",
  "charter-review": "charter review",
  active: "active",
  paused: "paused",
};
</script>

<template>
  <header class="topbar">
    <div class="brand">Research Hub</div>
    <div class="crumb">{{ store.info?.project ?? "" }}</div>
    <span v-if="status" class="badge" :class="status">{{ label[status] }}</span>
    <span v-if="store.project?.charterVersion" class="muted">charter v{{ store.project.charterVersion }}</span>
    <div class="spacer" />
    <span v-if="nextSweep" class="stat" :title="`Time zone ${store.project?.next.timeZone}`">next sweep {{ nextSweep }}</span>
    <button v-if="status === 'active'" class="ghost" @click="pause">Pause</button>
    <button v-else-if="status === 'paused'" class="ghost" @click="resume">Resume</button>
    <span class="badge" :class="mode" :title="`models: ${store.info?.providers.models}, jev: ${store.info?.providers.jev}`">{{ mode }}</span>
    <span class="stat" title="Cost this month (models + Jev)">{{ usd(store.totals?.monthUsd) }} this month</span>
    <span class="dot" :class="{ ok: store.connected }" :title="store.connected ? 'Live' : store.error || 'Connecting'" />
  </header>
</template>
