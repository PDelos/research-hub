<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { WeightView, Weekday } from "@rh/sdk";
import { client, refreshProject, refreshSchedule, store } from "../store.ts";

const days: { id: Weekday; label: string }[] = [
  { id: "mon", label: "Monday" },
  { id: "tue", label: "Tuesday" },
  { id: "wed", label: "Wednesday" },
  { id: "thu", label: "Thursday" },
  { id: "fri", label: "Friday" },
  { id: "sat", label: "Saturday" },
  { id: "sun", label: "Sunday" },
];
const form = ref({ sweepEnabled: true, sweepTime: "06:00", reviewEnabled: true, reviewDay: "sun" as Weekday, reviewTime: "07:00" });
const saved = ref("");
const fill = () => {
  const s = store.schedule;
  if (!s) return;
  form.value = {
    sweepEnabled: s.sweep.enabled,
    sweepTime: s.sweep.time,
    reviewEnabled: s.review.enabled,
    reviewDay: s.review.weekday,
    reviewTime: s.review.time,
  };
};
const weights = ref<WeightView[]>([]);
const cardsPerSweep = ref(7);
onMounted(async () => {
  await refreshSchedule();
  fill();
  [weights.value, { cardsPerSweep: cardsPerSweep.value }] = await Promise.all([client.weights(), client.sweepSettings()]);
});
async function saveCards() {
  try {
    cardsPerSweep.value = (await client.setSweepSettings({ cardsPerSweep: Number(cardsPerSweep.value) })).cardsPerSweep;
    saved.value = "Saved.";
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }
}
const kindLabel = { question: "Research question", query: "Search query", source: "Source" } as const;
watch(() => store.schedule, fill);

async function save() {
  saved.value = "";
  try {
    store.schedule = await client.setSchedule({
      sweep: { enabled: form.value.sweepEnabled, time: form.value.sweepTime },
      review: { enabled: form.value.reviewEnabled, weekday: form.value.reviewDay, time: form.value.reviewTime },
    });
    saved.value = "Saved.";
    await refreshProject();
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }
}

async function runNow(kind: "sweep" | "review") {
  const run = await client.triggerRun(kind);
  saved.value = run.status === "requested" ? `${kind} requested.` : `${kind} skipped: ${run.reason}.`;
  await refreshSchedule();
}
</script>

<template>
  <div class="settings">
    <h2>Schedule</h2>
    <p class="muted">Times are in {{ store.schedule?.timeZone ?? "UTC" }}. Saved settings take precedence over the container's defaults.</p>
    <fieldset>
      <label class="check"><input v-model="form.sweepEnabled" type="checkbox" /> Daily paper sweep</label>
      <label>at <input v-model="form.sweepTime" type="time" :disabled="!form.sweepEnabled" /></label>
      <button class="ghost" @click="runNow('sweep')">Run now</button>
    </fieldset>
    <fieldset>
      <label class="check"><input v-model="form.reviewEnabled" type="checkbox" /> Weekly review</label>
      <label>on
        <select v-model="form.reviewDay" :disabled="!form.reviewEnabled">
          <option v-for="d in days" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </label>
      <label>at <input v-model="form.reviewTime" type="time" :disabled="!form.reviewEnabled" /></label>
      <button class="ghost" @click="runNow('review')">Run now</button>
    </fieldset>
    <div class="row">
      <button class="primary" @click="save">Save schedule</button>
      <span class="muted">{{ saved }}</span>
    </div>
    <p class="muted small">The weekly review arrives in a later version; for now a due review is recorded as requested.</p>

    <h2>Cards</h2>
    <fieldset>
      <label>Cards per sweep <input v-model.number="cardsPerSweep" type="number" min="1" max="15" /></label>
      <button class="ghost" @click="saveCards">Save</button>
    </fieldset>

    <h2>Weights</h2>
    <p class="muted">Your judgments nudge these: 👍 +0.10, ⭐ +0.15, 👎 −0.15, kept between 0.1 and 2.</p>
    <table>
      <thead><tr><th>Kind</th><th>Name</th><th>Charter</th><th>Now</th></tr></thead>
      <tbody>
        <tr v-for="w in weights" :key="w.kind + w.key" class="static">
          <td class="muted">{{ kindLabel[w.kind] }}</td>
          <td>{{ w.key }}</td>
          <td>{{ w.base.toFixed(2) }}</td>
          <td :class="{ up: w.value > w.base, down: w.value < w.base }">{{ w.value.toFixed(2) }}</td>
        </tr>
        <tr v-if="!weights.length"><td colspan="4" class="muted center">No weights yet: approve the charter first.</td></tr>
      </tbody>
    </table>
  </div>
</template>
