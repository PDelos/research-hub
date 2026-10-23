<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { Weekday } from "@rh/sdk";
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
onMounted(async () => {
  await refreshSchedule();
  fill();
});
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
    <p class="muted small">Sweeps and reviews themselves arrive in later versions; for now a due run is recorded as requested.</p>
  </div>
</template>
