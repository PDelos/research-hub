<script setup lang="ts">
import { onMounted } from "vue";
import { ago, k, usd } from "@rh/sdk";
import { client, openRun, refreshSchedule, store } from "../store.ts";

onMounted(async () => {
  store.runs = await client.runs();
  await refreshSchedule();
});
</script>

<template>
  <div class="runs">
    <div class="totals" v-if="store.totals">
      <div><span class="label">Total</span>{{ usd(store.totals.totalUsd) }}</div>
      <div><span class="label">Models</span>{{ usd(store.totals.modelUsd) }}</div>
      <div><span class="label">Jev</span>{{ usd(store.totals.jevUsd) }} · {{ store.totals.jevCalls }} calls</div>
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
