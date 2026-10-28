<script setup lang="ts">
// The Upgrades tab (spec weekly-upgrade: Reports and proposals; design v1-4 D7): what the weekly upgrade worked on and
// why, every candidate it tried with its numbers, proposals waiting for Approve / Reject, add-on suggestions to
// dismiss, and earlier runs. Ranking winners are already applied; Undo takes them back.
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { UpgradeFocus, UpgradeProposal, UpgradeRun, UpgradesView } from "@rh/sdk";
import { isRhError } from "@rh/sdk";
import { client } from "../store.ts";
import { usePlugins } from "../stores/plugins.ts";

const plugins = usePlugins();
const view = ref<UpgradesView>();
const error = ref("");
const notice = ref("");
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const load = async () => {
  try {
    view.value = await client.upgrades();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
};
onMounted(async () => {
  await load();
  // While a run is in progress, follow it.
  timer = setInterval(() => void (view.value?.running && load()), 3000);
});
onUnmounted(() => clearInterval(timer));

const FOCUS: Record<UpgradeFocus, string> = {
  ranking: "Ranking (which papers become cards)",
  embedder: "Embedder (similarity and search)",
  converter: "Converter (PDFs to full text)",
  "scout-addons": "New sources and integrations",
};
const latest = computed(() => view.value?.runs[0]);
const earlier = computed(() => view.value?.runs.slice(1) ?? []);
const pending = computed(() => view.value?.proposals.filter((p) => p.status === "proposed") ?? []);
const proposalsOf = (run: UpgradeRun) => view.value?.proposals.filter((p) => p.runId === run.id) ?? [];
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(3));
const describe = (p: UpgradeProposal) =>
  p.kind === "converter"
    ? `Switch the converter to ${p.payload.converter}: score ${fmt(Number(p.payload.value))} vs ${fmt(Number(p.payload.activeValue))} for ${p.payload.active}`
    : p.kind === "embedder"
      ? `Switch the embedder to ${p.payload.model} (${p.payload.dims || "native"} dimensions): nDCG@10 ${fmt(Number(p.payload.mean))} vs ${fmt(Number(p.payload.activeMean))} for ${p.payload.activeModel}`
      : `Sweep settings ${JSON.stringify(p.payload.variant)}`;

async function act(fn: () => Promise<unknown>, done: string) {
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    await fn();
    notice.value = done;
    await load();
  } catch (e) {
    error.value = isRhError(e) ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
const run = (focus?: UpgradeFocus) =>
  act(() => client.runUpgrade(focus), "Started. The report appears here when it finishes.");
const approve = (p: UpgradeProposal) =>
  act(() => client.approveProposal(p.id), "Approved: the papers are re-embedded in the background.");
const reject = (p: UpgradeProposal) => act(() => client.rejectProposal(p.id), "Rejected.");
const dismiss = (id: number) => act(() => client.dismissSuggestion(id), "Dismissed.");
const undo = (p: UpgradeProposal) =>
  act(async () => {
    await client.undoPluginChange(p.commit!);
    await plugins.refresh();
  }, "Undone.");
</script>

<template>
  <div class="quality upgrades">
    <h2>Upgrades</h2>
    <p class="muted">
      Once every {{ view?.everyDays ?? 7 }} days the hub improves one thing on a fixed benchmark: the ranking (a winner
      is applied, with Undo), the embedder (a winner is proposed for your approval), or it looks for new sources to add.
      It never changes the core or how things are measured.
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <template v-if="view">
      <section class="digest-section" data-test="run-now">
        <p v-if="view.running" class="small"><span class="badge live">running</span> An upgrade is in progress…</p>
        <p v-else-if="!view.enabled" class="muted small">The weekly upgrade is off (Plugins → Weekly upgrade).</p>
        <p v-else class="muted small">{{ view.due ? "Due at the next nightly run." : "Not due yet." }}</p>
        <details>
          <summary class="small">Run one now</summary>
          <div class="row">
            <button class="ghost" :disabled="busy || view.running" @click="run()">Let Jev choose</button>
            <button v-for="(title, f) in FOCUS" :key="f" class="ghost" :disabled="busy || view.running" @click="run(f)">
              {{ title }}
            </button>
          </div>
        </details>
      </section>

      <section v-if="pending.length" class="digest-section" data-test="proposals">
        <h3>Waiting for you</h3>
        <ul class="replays">
          <li v-for="p in pending" :key="p.id">
            <div>{{ describe(p) }}</div>
            <div class="muted small" v-if="p.payload.reason">{{ p.payload.reason }}</div>
            <div class="row">
              <button class="primary" :disabled="busy" @click="approve(p)">Approve</button>
              <button class="ghost" :disabled="busy" @click="reject(p)">Reject</button>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="view.suggestions.length" class="digest-section" data-test="suggestions">
        <h3>Sources and integrations you could add</h3>
        <ul class="replays">
          <li v-for="s in view.suggestions" :key="s.id">
            <div>
              <a :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.name }}</a>
              <span class="muted small"> · {{ s.reason }}</span>
            </div>
            <button class="ghost small" :disabled="busy" @click="dismiss(s.id)">Dismiss</button>
          </li>
        </ul>
      </section>

      <section class="digest-section" data-test="latest">
        <h3>Latest upgrade</h3>
        <p v-if="!latest" class="muted">No upgrade has run yet.</p>
        <template v-else>
          <p>
            <strong>{{ FOCUS[latest.focus] }}</strong>
            <span class="muted small">
              · {{ day(latest.startedAt) }} · {{ latest.status }} · {{ usd(latest.costUsd) }}</span
            >
          </p>
          <p class="small">{{ latest.reason }}</p>
          <p v-if="latest.report" data-test="result">{{ latest.report.result }}</p>
          <ul v-for="p in proposalsOf(latest).filter((x) => x.status === 'applied' && x.commit)" :key="p.id">
            <li>
              Applied {{ JSON.stringify(p.payload.variant) }}
              <button class="ghost small" :disabled="busy" @click="undo(p)">Undo</button>
            </li>
          </ul>
          <table v-if="latest.report?.tried.length" class="small">
            <thead>
              <tr>
                <th>Tried</th>
                <th>Verdict</th>
                <th>Numbers</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in latest.report.tried" :key="i" class="static">
                <td>
                  {{ t.what }}<span v-if="t.why" class="muted"><br />{{ t.why }}</span>
                </td>
                <td>
                  <span v-if="t.verdict" class="badge" :class="'verdict-' + t.verdict.replaceAll(' ', '-')">{{
                    t.verdict
                  }}</span>
                </td>
                <td>
                  <template v-if="t.numbers">
                    <span v-for="(v, k) in t.numbers" :key="k">{{ k }} {{ fmt(v) }} </span>
                  </template>
                  <span v-if="t.note" class="muted">{{ t.note }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <section v-if="earlier.length" class="digest-section">
        <h3>Earlier</h3>
        <ul class="replays">
          <li v-for="r in earlier" :key="r.id">
            <strong>{{ FOCUS[r.focus] }}</strong>
            <span class="muted small"> · {{ day(r.startedAt) }} · {{ usd(r.costUsd) }}</span>
            <div class="small">{{ r.report?.result }}</div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
