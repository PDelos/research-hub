<script setup lang="ts">
import { onMounted } from "vue";
import { ago, k, usd } from "@rh/sdk";
import { client, openRun, openSweep, refreshFeed, refreshSchedule, store } from "../store.ts";

onMounted(async () => {
  store.runs = await client.runs();
  await Promise.all([refreshSchedule(), refreshFeed()]);
});

const PHASES = ["plan", "gather", "dedupe", "gate", "enrich", "level", "rank", "cards"] as const;
const counts = (c?: Record<string, number>) => (c ? Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") : "");
</script>

<template>
  <div class="runs">
    <div class="totals" v-if="store.totals">
      <div><span class="label">Total</span>{{ usd(store.totals.totalUsd) }}</div>
      <div><span class="label">Models</span>{{ usd(store.totals.modelUsd) }}</div>
      <div><span class="label">Jev</span>{{ usd(store.totals.jevUsd) }} · {{ store.totals.jevCalls }} calls</div>
      <div><span class="label">Embeddings</span>{{ usd(store.totals.embeddingUsd) }} · {{ store.totals.embeddingCalls }} calls</div>
      <div><span class="label">Runs</span>{{ store.totals.runs }}</div>
    </div>
    <table>
      <thead>
        <tr><th>Run</th><th>Status</th><th>Model</th><th>Tools</th><th>Tokens in / out</th><th>Cost</th><th>When</th></tr>
      </thead>
      <tbody>
        <tr v-for="run in store.runs" :key="run.id" :class="{ sel: store.run?.id === run.id }" @click="openRun(run.id)">
          <td class="clip">{{ run.text }}</td>
          <td>{{ run.status }}</td>
          <td class="muted">{{ run.models.join(", ") }}</td>
          <td>{{ run.toolCalls }}</td>
          <td>{{ k(run.inputTokens) }} / {{ k(run.outputTokens) }}</td>
          <td>{{ usd(run.costUsd) }}</td>
          <td class="muted">{{ ago(run.startedAt) }}</td>
        </tr>
        <tr v-if="!store.runs.length"><td colspan="7" class="muted center">No runs yet.</td></tr>
      </tbody>
    </table>
    <h3 class="section">Sweeps</h3>
    <table>
      <thead>
        <tr><th>Sweep</th><th>Status</th><th>Phase</th><th>Gathered → gated → cards</th><th>Jev</th><th>Embeddings</th><th>Model</th><th>Total</th><th>When</th></tr>
      </thead>
      <tbody>
        <tr v-for="s in store.sweeps" :key="s.id" :class="{ sel: store.sweepDetail?.id === s.id }" @click="openSweep(s.id)">
          <td>{{ s.id }}<span v-if="s.orientation" class="muted"> · foundations</span></td>
          <td :class="{ error: s.status === 'failed' }">{{ s.status.replace(/_/g, " ") }}</td>
          <td class="muted">{{ s.status === "running" ? s.phase : "" }}</td>
          <td>{{ s.counts.gathered ?? 0 }} → {{ s.counts.gated ?? 0 }} → {{ s.cards }}</td>
          <td>{{ s.cost ? usd(s.cost.jevUsd) : "" }}</td>
          <td>{{ s.cost ? usd(s.cost.embeddingUsd) : "" }}</td>
          <td>{{ s.cost ? usd(s.cost.modelUsd) : "" }}</td>
          <td>{{ s.cost ? usd(s.cost.totalUsd) : "" }}</td>
          <td class="muted">{{ ago(s.startedAt) }}</td>
        </tr>
        <tr v-if="!store.sweeps.length"><td colspan="9" class="muted center">No sweeps yet.</td></tr>
      </tbody>
    </table>
    <div v-if="store.sweepDetail" class="run-detail">
      <h3>Sweep {{ store.sweepDetail.id }}</h3>
      <p v-if="store.sweepDetail.error" class="error">{{ store.sweepDetail.error }}</p>
      <h4>Phases</h4>
      <ul>
        <li v-for="name in PHASES" :key="name">
          <strong>{{ name }}</strong> · {{ store.sweepDetail.phases[name]?.status ?? "not reached" }}
          <span v-if="(store.sweepDetail.phases[name]?.attempts ?? 0) > 1"> · {{ store.sweepDetail.phases[name]?.attempts }} attempts</span>
          <span class="muted"> {{ counts(store.sweepDetail.phases[name]?.counts) }}</span>
          <span v-if="store.sweepDetail.phases[name]?.error" class="error"> · {{ store.sweepDetail.phases[name]?.error }}</span>
        </li>
      </ul>
      <h4>Queries</h4>
      <p class="muted">{{ store.sweepDetail.queries.map((q) => q.text).join(" · ") }}<span v-if="store.sweepDetail.windowSince"> (since {{ store.sweepDetail.windowSince }})</span></p>
      <h4>Papers</h4>
      <ul>
        <li v-for="p in store.sweepDetail.papers" :key="p.paperId">
          <span class="badge">{{ p.status.replace(/_/g, " ") }}</span> {{ p.title }}
          <span class="muted"><span v-if="p.rank"> · rank {{ p.rank }}</span><span v-if="p.relevance !== undefined"> · relevance {{ p.relevance.toFixed(2) }}</span><span v-if="p.reason"> · {{ p.reason }}</span></span>
        </li>
      </ul>
    </div>
    <h3 class="section">Scheduled sweeps and reviews</h3>
    <table>
      <thead>
        <tr><th>Kind</th><th>Slot</th><th>Trigger</th><th>Status</th><th>Reason</th><th>Recorded</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in store.scheduledRuns" :key="r.id" class="static">
          <td>{{ r.kind }}</td>
          <td class="muted">{{ r.slotAt ? new Date(r.slotAt).toLocaleString() : "now" }}</td>
          <td>{{ r.trigger }}</td>
          <td>{{ r.status }}</td>
          <td class="muted">{{ r.reason ?? "" }}</td>
          <td class="muted">{{ ago(r.createdAt) }}</td>
        </tr>
        <tr v-if="!store.scheduledRuns.length"><td colspan="6" class="muted center">No scheduled runs yet.</td></tr>
      </tbody>
    </table>
    <div v-if="store.run" class="run-detail">
      <h3>Run {{ store.run.id }}</h3>
      <h4>Model calls</h4>
      <ul>
        <li v-for="g in store.run.generationList" :key="g.entryId">
          {{ g.model }} · {{ g.stopReason }} · {{ k(g.inputTokens) }} in / {{ k(g.outputTokens) }} out · {{ usd(g.costUsd) }}
        </li>
      </ul>
      <h4>Tool calls</h4>
      <ul>
        <li v-for="c in store.run.toolCallList" :key="c.id">
          <strong>{{ c.toolName }}</strong> · {{ c.status }}<span v-if="c.isError" class="error"> · error</span>
          <pre v-if="c.result">{{ c.result }}</pre>
        </li>
        <li v-if="!store.run.toolCallList.length" class="muted">None</li>
      </ul>
    </div>
  </div>
</template>
