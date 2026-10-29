<script setup lang="ts">
import KnowledgeProposals from "./KnowledgeProposals.vue";
// The weekly digest (spec daily-cycle: Weekly digest, Comments, What changed): what the cycle did this week, every
// change with an undo, and a comment box per section. Reading and commenting is the user's whole job here.
import { computed, onMounted, ref } from "vue";
import { isRhError, type DigestSection, type DigestSummary, type DigestView, type KnowledgeProposal } from "@rh/sdk";
import { client } from "../store.ts";
import { usePlugins } from "../stores/plugins.ts";
import CycleStatus from "./CycleStatus.vue";

const plugins = usePlugins();
const list = ref<DigestSummary[]>([]);
const digest = ref<DigestView>();
const drafts = ref<Record<string, string>>({});
const notice = ref("");
const error = ref("");

const sections: { id: DigestSection; title: string }[] = [
  { id: "cycle", title: "The week's cycle" },
  { id: "judgments", title: "Your judgments" },
  { id: "exploration", title: "Exploration picks" },
  { id: "knowledgeBase", title: "Knowledge base" },
  { id: "quality", title: "Quality" },
  { id: "sources", title: "Sources" },
  { id: "upgrade", title: "Weekly upgrade" },
  { id: "charter", title: "Charter and questions" },
  { id: "cost", title: "Cost" },
  { id: "changes", title: "What changed" },
  { id: "general", title: "Anything else" },
];
const commentsOf = (section: string) => digest.value?.comments.filter((c) => c.section === section) ?? [];
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const pct = (p: number | null) => (p === null ? "—" : `${Math.round(p * 100)}%`);
const verdictIcon: Record<string, string> = { up: "👍", down: "👎", star: "⭐" };
const undone = computed(
  () => new Set(plugins.history.filter((h) => h.message.startsWith("undo: ")).map((h) => h.message.slice(6))),
);

async function open(id: number) {
  error.value = "";
  digest.value = await client.digest(id);
  await loadLive();
}
// The digest is a snapshot; a proposal's status is shown as it is now (approved from here or the Charter tab).
const live = ref<Map<number, KnowledgeProposal>>(new Map());
async function loadLive() {
  try {
    live.value = new Map((await client.knowledge()).proposals.map((p) => [p.id, p]));
  } catch {
    live.value = new Map();
  }
}
const charterProposals = computed(() => (digest.value?.charter?.proposals ?? []).map((p) => live.value.get(p.id) ?? p));
async function load() {
  list.value = await client.digests();
  if (list.value.length && !digest.value) await open(list.value[0].id);
  await plugins.loadHistory();
}
onMounted(load);

async function buildNow() {
  notice.value = "";
  const run = await client.triggerRun("review");
  notice.value = run.status === "requested" ? "Building the digest…" : `Not built: ${run.reason}.`;
  for (let i = 0; i < 40 && run.status === "requested"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const fresh = await client.digests();
    if (fresh.length > list.value.length) {
      list.value = fresh;
      await open(fresh[0].id);
      notice.value = "";
      return;
    }
  }
}
async function comment(section: DigestSection) {
  const text = drafts.value[section]?.trim();
  if (!text || !digest.value) return;
  try {
    await client.commentDigest(digest.value.id, section, text);
    drafts.value[section] = "";
    await open(digest.value.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function undo(commit: string, message: string) {
  error.value = "";
  try {
    await client.undoPluginChange(commit);
    notice.value = `Undone: ${message}`;
    await plugins.refresh();
    await plugins.loadHistory();
  } catch (e) {
    error.value = isRhError(e) ? e.message : String(e);
  }
}
</script>

<template>
  <div class="digest">
    <div class="digest-head">
      <h2>Weekly digest</h2>
      <select
        v-if="list.length"
        :value="digest?.id"
        aria-label="Week"
        @change="open(Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="d in list" :key="d.id" :value="d.id">{{ d.week }} · {{ day(d.to) }}</option>
      </select>
      <span class="spacer" />
      <button class="ghost" @click="buildNow">Build a digest now</button>
    </div>
    <CycleStatus />
    <p v-if="notice" class="muted">{{ notice }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!list.length" class="empty muted">
      The first digest arrives at the end of the week (or build one now). It sums up the sweeps, your judgments, the
      exploration picks, new notes, cost and every change the system made, each with an undo.
    </p>

    <template v-if="digest">
      <p class="muted small">{{ day(digest.from) }} – {{ day(digest.to) }}</p>
      <section v-if="digest.lastComments.length" class="digest-section">
        <h3>Your comments last week</h3>
        <ul>
          <li v-for="c in digest.lastComments" :key="c.createdAt">
            <span class="muted small">{{ c.section }}:</span> {{ c.text }}
          </li>
        </ul>
      </section>

      <section v-for="sec in sections" :key="sec.id" class="digest-section" :data-section="sec.id">
        <h3>{{ sec.title }}</h3>
        <template v-if="sec.id === 'cycle'">
          <p>
            {{ digest.cycle.sweeps.length }} sweeps, {{ digest.cycle.sweeps.reduce((n, s) => n + s.cards, 0) }} cards,
            {{ digest.cycle.nightlyRuns }} nightly runs.
          </p>
          <ul class="small">
            <li v-for="s in digest.cycle.sweeps" :key="s.id">
              {{ day(s.startedAt) }}: {{ s.cards }} cards ({{ s.status.replaceAll("_", " ") }})
            </li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'judgments'">
          <p>
            ⭐ {{ digest.judgments.star }} · 👍 {{ digest.judgments.up }} · 👎 {{ digest.judgments.down }} —
            {{ digest.judgments.waiting }} cards still waiting.
          </p>
          <ul class="small">
            <li v-for="p in digest.judgments.precision" :key="p.sweepId">
              {{ day(p.startedAt) }}: precision@5 {{ pct(p.precision) }} ({{ p.good }} good of {{ p.judged }} judged)
            </li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'exploration'">
          <p v-if="!digest.exploration.picks.length" class="muted">No exploration picks this week.</p>
          <ul class="small">
            <li v-for="x in digest.exploration.picks" :key="x.sweepId + '-' + x.paperId">
              {{ x.title }} — {{ x.verdict ? verdictIcon[x.verdict] : "not judged yet" }}
            </li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'knowledgeBase'">
          <p v-if="!digest.knowledgeBase.added.length" class="muted">No new notes.</p>
          <ul class="small">
            <li v-for="n in digest.knowledgeBase.added" :key="n.stem">{{ n.title }}</li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'quality'">
          <p v-if="!digest.quality?.judge" class="muted">The judge has not been calibrated yet.</p>
          <p v-else>
            The judge agrees with you in {{ pct(digest.quality.judge.agreement) }} of
            {{ digest.quality.judge.cases }} cases ({{ digest.quality.judge.trusted ? "trusted" : "not trusted yet" }}).
          </p>
          <ul class="small">
            <li v-for="r in digest.quality?.replays ?? []" :key="r.id">
              {{ Object.keys(r.variant).join(", ") || "current settings" }}: <strong>{{ r.verdict }}</strong> ({{
                r.heldOutDiff >= 0 ? "+" : ""
              }}{{ r.heldOutDiff.toFixed(2) }} nDCG)
            </li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'sources'">
          <p v-if="!digest.sources?.length" class="muted">No cards came in this week.</p>
          <ul class="small">
            <li v-for="x in digest.sources ?? []" :key="x.source">
              {{ x.source }}: {{ x.cards }} cards, {{ x.liked }} liked
            </li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'upgrade'">
          <p v-if="!digest.upgrade?.runs.length" class="muted">No upgrade ran this week.</p>
          <ul class="changes small">
            <li v-for="u in digest.upgrade?.runs ?? []" :key="u.id">
              <span>
                <strong>{{ u.focus }}</strong> · {{ u.reason }} — {{ u.result }}
                <span class="muted">({{ u.tried }} tried)</span>
                <a href="#/upgrades" class="small">Details</a>
              </span>
              <template v-for="p in u.proposals" :key="p.id">
                <button
                  v-if="p.status === 'applied' && p.commit"
                  class="ghost small"
                  @click="undo(p.commit, `upgrade ${u.id}`)"
                >
                  Undo
                </button>
              </template>
            </li>
          </ul>
        </template>
        <template v-else-if="sec.id === 'charter'">
          <p v-for="n in digest.charter?.reviewNotes ?? []" :key="n" class="muted small">{{ n }}</p>
          <KnowledgeProposals :proposals="charterProposals" @changed="loadLive" />
          <p v-if="digest.charter?.finders?.some((f) => f.proposed)" class="muted small" data-test="finder-stats">
            Question finders:
            <template v-for="(f, i) in digest.charter.finders.filter((x) => x.proposed)" :key="f.finder"
              >{{ i ? "; " : "" }}{{ f.title }} {{ f.approved }}/{{ f.proposed }} approved,
              {{ f.liked }} liked</template
            >
          </p>
        </template>
        <template v-else-if="sec.id === 'cost'">
          <p>
            {{ usd(digest.cost.totalUsd) }} (models {{ usd(digest.cost.modelUsd) }}, Jev {{ usd(digest.cost.jevUsd) }},
            embeddings {{ usd(digest.cost.embeddingUsd) }})
          </p>
        </template>
        <template v-else-if="sec.id === 'changes'">
          <p v-if="!digest.changes.length" class="muted">Nothing changed this week.</p>
          <ul class="changes">
            <li v-for="c in digest.changes" :key="c.id" :data-change="c.message">
              <span
                >{{ day(c.time) }} · {{ c.message }} <span class="muted small">({{ c.actor }})</span></span
              >
              <span v-if="undone.has(c.message)" class="muted small">undone</span>
              <button v-else-if="!c.message.startsWith('undo: ')" class="ghost small" @click="undo(c.id, c.message)">
                Undo
              </button>
            </li>
          </ul>
        </template>
        <ul v-if="commentsOf(sec.id).length" class="comments small">
          <li v-for="c in commentsOf(sec.id)" :key="c.id">💬 {{ c.text }}</li>
        </ul>
        <form class="comment-form" @submit.prevent="comment(sec.id)">
          <input
            v-model="drafts[sec.id]"
            :aria-label="`Comment on ${sec.title}`"
            placeholder="Your opinion (optional)"
          />
          <button class="ghost" type="submit">Comment</button>
        </form>
      </section>
    </template>
  </div>
</template>
