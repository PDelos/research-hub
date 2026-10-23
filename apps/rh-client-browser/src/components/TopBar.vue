<script setup lang="ts">
import { computed } from "vue";
import { usd } from "@rh/sdk";
import { store } from "../store.ts";

const mode = computed(() => store.info?.mode ?? "…");
</script>

<template>
  <header class="topbar">
    <div class="brand">Research Hub</div>
    <div class="crumb">{{ store.info?.project ?? "" }}</div>
    <div class="spacer" />
    <span class="badge" :class="mode" :title="`models: ${store.info?.providers.models}, jev: ${store.info?.providers.jev}`">{{ mode }}</span>
    <span class="stat" title="Cost this month (models + Jev)">{{ usd(store.totals?.monthUsd) }} this month</span>
    <span class="dot" :class="{ ok: store.connected }" :title="store.connected ? 'Live' : store.error || 'Connecting'" />
  </header>
</template>
