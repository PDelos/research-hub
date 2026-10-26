<script setup lang="ts">
// Where the daily cycle stands (spec daily-cycle: Cycle status): the last sweep, cards waiting, the next runs.
import { onMounted, ref, watch } from "vue";
import type { CycleStatus } from "@rh/sdk";
import { client, store } from "../store.ts";

const cycle = ref<CycleStatus>();
const load = async () => {
  try {
    cycle.value = await client.cycle();
  } catch {
    // The status line is optional.
  }
};
onMounted(load);
watch(() => [store.feed, store.sweep], load);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "off";
</script>

<template>
  <p v-if="cycle" class="cycle-status muted small" data-test="cycle-status">
    <template v-if="cycle.lastSweep">
      Last sweep: {{ cycle.lastSweep.cards }} cards ·
      <strong>{{ cycle.waiting }} {{ cycle.waiting === 1 ? "card" : "cards" }} waiting</strong> ·
    </template>
    <template v-else>No sweep yet · </template>
    next sweep {{ when(cycle.next.sweep) }} · nightly {{ when(cycle.next.nightly) }} · digest
    {{ when(cycle.next.review) }}
  </p>
</template>
