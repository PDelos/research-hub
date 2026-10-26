<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ago, usd, type CardDetail, type CardView, type Verdict } from "@rh/sdk";
import { client, refreshFeed, store } from "../store.ts";

const open = ref<Record<number, CardDetail | undefined>>({});
const starting = ref(false);

onMounted(() => void refreshFeed());

async function toggle(id: number) {
  if (open.value[id]) open.value = { ...open.value, [id]: undefined };
  else open.value = { ...open.value, [id]: await client.card(id) };
}

async function runSweep() {
  starting.value = true;
  try {
    await client.triggerRun("sweep");
    await refreshFeed();
  } finally {
    starting.value = false;
  }
}

const phaseLabel: Record<string, string> = {
  plan: "planning queries",
  gather: "searching sources",
  dedupe: "dropping papers seen before",
  gate: "Jev is judging relevance",
  enrich: "fetching metadata",
  level: "Jev is leveling papers",
  rank: "ranking",
  cards: "writing cards",
};
const reasons = ref<Record<number, string>>({});
const busy = ref<Record<number, boolean>>({});
const ICON: Record<Verdict, string> = { down: "👎", up: "👍", star: "⭐" };
const LABEL: Record<Verdict, string> = { down: "Not useful", up: "Interesting", star: "Add to knowledge base" };

async function judge(card: CardView, verdict: Verdict) {
  busy.value = { ...busy.value, [card.id]: true };
  try {
    const reason = reasons.value[card.id] ?? card.judgment?.reason ?? "";
    const detail =
      card.judgment?.verdict === verdict && !reasons.value[card.id]
        ? await client.clearJudgment(card.id)
        : await client.judge(card.id, verdict, reason || undefined);
    if (open.value[card.id]) open.value = { ...open.value, [card.id]: detail };
    await refreshFeed();
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = { ...busy.value, [card.id]: false };
  }
}

async function saveReason(card: CardView) {
  if (!card.judgment) return;
  await judge(card, card.judgment.verdict);
  reasons.value = { ...reasons.value, [card.id]: "" };
}

const trend = computed(() => [...store.precision].reverse().slice(-12));
const latestPrecision = computed(() => store.precision.find((p) => p.judged > 0));
const scoreClass = (n: number) => (n >= 70 ? "hi" : n >= 45 ? "mid" : "lo");
const authors = (a: string[]) => (a.length > 3 ? `${a.slice(0, 3).join(", ")} et al.` : a.join(", "));
</script>

<template>
  <div class="feed">
    <div class="feed-head">
      <h2>Feed</h2>
      <span v-if="store.sweep?.status === 'running'" class="badge live"
        >Sweep {{ store.sweep.id }}: {{ phaseLabel[store.sweep.phase] }}…</span
      >
      <span v-else-if="store.sweep?.status === 'failed'" class="badge offline" :title="store.sweep.error"
        >Last sweep failed</span
      >
      <span class="grow" />
      <div
        v-if="latestPrecision"
        class="precision"
        :title="`Share of each sweep's top 5 cards you liked or starred, among those you judged`"
      >
        <svg :width="trend.length * 9" height="22" aria-hidden="true">
          <rect
            v-for="(p, i) in trend"
            :key="p.sweepId"
            :x="i * 9"
            :y="22 - 2 - (p.precision ?? 0) * 18"
            width="6"
            :height="2 + (p.precision ?? 0) * 18"
            :class="{ none: p.precision === null }"
          />
        </svg>
        <span class="muted"
          >precision@5 {{ Math.round(latestPrecision.precision! * 100) }}% ({{ latestPrecision.judged }} of
          {{ latestPrecision.top }} judged)</span
        >
      </div>
      <button
        class="ghost"
        :disabled="starting || store.sweep?.status === 'running' || store.project?.status !== 'active'"
        :title="store.project?.status !== 'active' ? 'Approve the charter first' : 'Run a sweep now'"
        @click="runSweep"
      >
        Run sweep now
      </button>
    </div>

    <div v-if="!store.feed.length" class="empty">
      <h2>No papers yet</h2>
      <p v-if="store.project?.status !== 'active'">
        Approve the charter first; the daily sweep then brings a few paper cards each day.
      </p>
      <p v-else-if="store.sweep?.status === 'running'">
        The first sweep is running. Cards appear here as they are written.
      </p>
      <p v-else-if="store.sweep?.status === 'no_new_papers'">The last sweep found nothing new that fits the charter.</p>
      <p v-else>Cards arrive with the next sweep, or press “Run sweep now”.</p>
    </div>

    <section v-for="group in store.feed" :key="group.sweep.id" class="sweep-group">
      <h3 class="section">
        Sweep {{ group.sweep.id }} · {{ ago(group.sweep.startedAt) }}
        <span class="muted"
          >· {{ group.cards.length }} cards<span v-if="group.sweep.orientation"> · foundations first</span
          ><span v-if="group.sweep.cost"> · {{ usd(group.sweep.cost.totalUsd) }}</span></span
        >
      </h3>
      <article v-for="card in group.cards" :key="card.id" class="card">
        <header>
          <a
            v-if="card.paper.link"
            :href="card.paper.link"
            target="_blank"
            rel="noopener noreferrer"
            class="card-title"
            >{{ card.paper.title }}</a
          >
          <span v-else class="card-title">{{ card.paper.title }}</span>
          <div class="meta muted">
            {{ authors(card.paper.authors) }} · {{ card.paper.year ?? "n.d." }} ·
            {{ card.paper.venue ?? card.paper.server ?? "unknown venue" }}
            <span v-if="card.paper.citations !== undefined"> · {{ card.paper.citations }} citations</span>
          </div>
        </header>
        <div class="tags">
          <span class="badge level">{{ card.level }}</span>
          <span
            v-if="card.exploration"
            class="badge exploration"
            title="An exploration pick: a paper unlike the ones you liked, so the feed does not narrow. Judge it like any other."
            >Exploration</span
          >
          <span v-if="card.borderline" class="badge offline" title="Passed the gate in the review band"
            >borderline · relevance {{ card.relevance }}</span
          >
          <span v-if="card.matchedQuestion" class="badge" :title="card.matchedQuestion.text"
            >{{ card.matchedQuestion.id }}: {{ card.matchedQuestion.text }}</span
          >
        </div>
        <p class="summary">{{ card.summary }}</p>
        <div class="scores">
          <div :class="['score', scoreClass(card.relevance)]">
            <strong>Relevance {{ card.relevance }}</strong
            ><span>{{ card.relevanceReason }}</span>
          </div>
          <div :class="['score', scoreClass(card.trust)]">
            <strong>Trust {{ card.trust }}</strong
            ><span>{{ card.trustReason }}</span>
          </div>
          <div :class="['score', scoreClass(card.value)]">
            <strong>Value {{ card.value }}</strong
            ><span>{{ card.valueReason }}</span>
          </div>
        </div>
        <div class="judge">
          <button
            v-for="v in ['down', 'up', 'star'] as const"
            :key="v"
            :class="['verdict', { on: card.judgment?.verdict === v }]"
            :title="card.judgment?.verdict === v ? 'Click again to remove' : LABEL[v]"
            :disabled="busy[card.id]"
            @click="judge(card, v)"
          >
            {{ ICON[v] }}
          </button>
          <span v-if="card.judgment?.reason" class="muted reason-shown"
            >“{{ card.judgment.reason }}”<span
              v-if="card.judgment.ruleStatus === 'candidate'"
              class="badge"
              title="Queued for the weekly digest as a possible rule"
              >rule?</span
            ></span
          >
        </div>
        <div v-if="card.judgment" class="reason-box">
          <textarea
            v-model="reasons[card.id]"
            maxlength="1000"
            rows="2"
            :placeholder="card.judgment.reason ? 'Change your reason…' : 'Why? (optional, helps the next sweeps)'"
          />
          <button class="ghost" :disabled="!reasons[card.id] || busy[card.id]" @click="saveReason(card)">
            Save reason
          </button>
        </div>
        <button class="link" @click="toggle(card.id)">
          {{ open[card.id] ? "Hide details" : "How these scores were computed" }}
        </button>
        <div v-if="open[card.id]" class="card-details">
          <template v-if="open[card.id]!.weightEffects.length">
            <h4>Your judgment changed these weights</h4>
            <ul>
              <li v-for="e in open[card.id]!.weightEffects" :key="e.kind + e.key">
                {{ e.kind }} “{{ e.key }}”: {{ e.before.toFixed(2) }} → {{ e.after.toFixed(2) }}
              </li>
            </ul>
          </template>
          <h4>Formulas</h4>
          <ul>
            <li v-for="(f, name) in open[card.id]!.details.formulas" :key="name">
              <strong>{{ name }}</strong
              >: {{ f }}
            </li>
          </ul>
          <h4>Inputs</h4>
          <ul>
            <li v-for="(v, name) in open[card.id]!.details.inputs" :key="name">{{ name }}: {{ v ?? "—" }}</li>
          </ul>
          <h4>Jev decisions</h4>
          <ul>
            <li v-for="(d, name) in open[card.id]!.details.decisions" :key="name">
              <strong>{{ name }}</strong> v{{ d.version }}: <code>{{ JSON.stringify(d.answers) }}</code>
            </li>
          </ul>
          <h4 v-if="open[card.id]!.paper.abstract">Abstract</h4>
          <p v-if="open[card.id]!.paper.abstract" class="muted">{{ open[card.id]!.paper.abstract }}</p>
        </div>
      </article>
    </section>
  </div>
</template>
