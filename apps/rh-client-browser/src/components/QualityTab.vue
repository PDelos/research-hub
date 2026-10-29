<script setup lang="ts">
// The Quality tab (spec harness: Quality view): how well the judge agrees with you, how good the cards have been
// (the current settings replayed over past sweeps), and every replay with its numbers and verdict.
import { computed, onMounted, ref } from "vue";
import type { HarnessQuality, StoredReplay } from "@rh/sdk";
import { client } from "../store.ts";

const quality = ref<HarnessQuality>();
const error = ref("");
const variantText = ref('{ "cardsPerSweep": 10 }');
const running = ref(false);
const load = async () => {
  try {
    quality.value = await client.quality();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  }
};
onMounted(load);

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const twoDecimals = (x: number | undefined) => (x === undefined ? "—" : x.toFixed(2));
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const describe = (r: StoredReplay) =>
  Object.entries(r.variant)
    .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(", ") || "current settings";
const judgeNote = computed(() => {
  const j = quality.value?.judge;
  if (!j) return "The judge is calibrated each night once you have judged cards.";
  if (j.trusted) return "Trusted: unjudged papers in replays are labelled by the judge.";
  if (j.cases < j.minCases) return `Not trusted yet: ${j.minCases - j.cases} more judged cards needed.`;
  return `Not trusted: it needs ${pct(j.minAgreement)} agreement. Replays use only your judgments.`;
});

async function replay() {
  error.value = "";
  let variant: unknown;
  try {
    variant = JSON.parse(variantText.value);
  } catch {
    error.value = `The setting must be JSON, for example { "cardsPerSweep": 10 }.`;
    return;
  }
  running.value = true;
  try {
    await client.replay(variant as never);
    await load();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="quality">
    <h2>Quality</h2>
    <p class="muted">
      How good your cards have been, measured on your own judgments. Changes to how papers are found are replayed on
      past sweeps before anything changes; the most recent sweeps are held out to check a result is real.
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="quality">
      <section class="digest-section" data-test="judge">
        <h3>The judge</h3>
        <p>
          Agrees with you in <strong>{{ pct(quality.judge?.agreement) }}</strong> of
          {{ quality.judge?.cases ?? 0 }} judged cards<template
            v-if="quality.judge?.kappa !== null && quality.judge?.kappa !== undefined"
          >
            (kappa {{ quality.judge.kappa.toFixed(2) }})</template
          >.
        </p>
        <p class="muted small">
          {{ judgeNote }} Labels: {{ quality.labels.judged }} yours, {{ quality.labels.judge }} the judge's.
        </p>
      </section>

      <section class="digest-section">
        <h3>Your cards over time</h3>
        <p v-if="!quality.overTime.length" class="muted">No finished sweeps yet.</p>
        <table v-else class="small">
          <thead>
            <tr>
              <th>Sweep</th>
              <th>nDCG</th>
              <th>Precision@5</th>
              <th>Judged</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="q in quality.overTime" :key="q.sweepId" class="static">
              <td>{{ day(q.startedAt) }}</td>
              <td>{{ twoDecimals(q.ndcg) }}</td>
              <td>{{ pct(q.precision5) }}</td>
              <td>{{ pct(q.coverage) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="digest-section" data-test="replays">
        <h3>Replays</h3>
        <p v-if="!quality.replays.length" class="muted">
          No replays yet. The weekly upgrade runs them; you can ask the desk ("would 10 cards a day be better?") or try
          one here.
        </p>
        <ul class="replays">
          <li v-for="r in quality.replays" :key="r.id" :data-verdict="r.report.verdict">
            <div>
              <span class="badge" :class="'verdict-' + r.report.verdict.replaceAll(' ', '-')">{{
                r.report.verdict
              }}</span>
              <strong>{{ describe(r) }}</strong>
              <span class="muted small"> · {{ day(r.createdAt) }} · by {{ r.requestedBy }}</span>
            </div>
            <div v-if="r.report.verdict === 'not enough data'" class="small muted">
              {{ r.report.sweeps.labelled }} of {{ r.report.sweeps.total }} past sweeps have judged cards; 3 are needed.
            </div>
            <div v-else class="small">
              nDCG {{ twoDecimals(r.report.mean.current.ndcg) }} → {{ twoDecimals(r.report.mean.candidate.ndcg) }};
              latest {{ r.report.heldOut.n }} sweeps {{ signed(r.report.heldOut.diff) }} (95 % interval
              {{ signed(r.report.heldOut.low) }} to {{ signed(r.report.heldOut.high) }}); precision@5
              {{ pct(r.report.mean.current.precision5) }} → {{ pct(r.report.mean.candidate.precision5) }}
              <span v-if="r.report.estimated" class="muted"> · {{ r.report.estimated }} estimated</span>
              <span class="muted"> · {{ r.report.judgeUsed ? "with the judge's labels" : "your judgments only" }}</span>
            </div>
          </li>
        </ul>
        <details>
          <summary class="small">Try a setting</summary>
          <form class="comment-form" @submit.prevent="replay">
            <input v-model="variantText" aria-label="Setting to replay" />
            <button class="ghost" type="submit" :disabled="running">{{ running ? "Replaying…" : "Replay" }}</button>
          </form>
          <p class="muted small">
            Any of relevanceMin, worthMin, rankWeights, cardsPerSweep, explorationPicks. Nothing changes; no paid calls.
          </p>
        </details>
      </section>
    </template>
  </div>
</template>
