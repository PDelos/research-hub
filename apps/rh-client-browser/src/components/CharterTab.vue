<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { CharterBody, KnowledgeView } from "@rh/sdk";
import BriefScreen from "./BriefScreen.vue";
import KnowledgeProposals from "./KnowledgeProposals.vue";
import { act, client, store } from "../store.ts";

const view = computed(() => store.charter);
const running = computed(() => view.value?.run?.status === "running");
const failed = computed(() => view.value?.run?.status === "failed");
const openQuestions = computed(() => (view.value?.questions ?? []).filter((q) => q.answer === null));
const answers = ref<Record<number, string>>({});
const replacingBrief = ref(false);
const briefText = ref("");

/** Which charter is shown: the open draft, or an approved version. */
const selected = ref<"draft" | number>("draft");
const shown = computed(() => {
  const charter = view.value;
  if (!charter) return undefined;
  if (selected.value === "draft") return charter.draft ?? charter.approved ?? undefined;
  return selected.value === charter.approved?.version ? charter.approved : versionCache.value[selected.value];
});
const versionCache = ref<Record<number, NonNullable<typeof store.charter>["approved"]>>({});
watch(selected, async (version) => {
  if (version !== "draft" && !versionCache.value[version])
    versionCache.value[version] = await client.charterVersion(version);
});

// Editing works on a copy of the shown charter; lists are edited one item per line.
const editing = ref(false);
const draft = ref<CharterBody>();
const lines = (list: string[]) => list.join("\n");
const unlines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const text = ref({ concepts: "", subAreas: "", outOfScope: "" });
function startEdit() {
  if (!shown.value) return;
  draft.value = structuredClone(shown.value.charter);
  text.value = {
    concepts: lines(draft.value.concepts),
    subAreas: lines(draft.value.subAreas),
    outOfScope: lines(draft.value.outOfScope),
  };
  editing.value = true;
}
function addQuestion() {
  draft.value?.questions.push({ id: "", text: "", weight: 1 });
}
function addQuery() {
  draft.value?.queries.push({ text: "", weight: 1 });
}
async function saveEdit() {
  if (!draft.value) return;
  const body: CharterBody = {
    ...draft.value,
    concepts: unlines(text.value.concepts),
    subAreas: unlines(text.value.subAreas),
    outOfScope: unlines(text.value.outOfScope),
  };
  try {
    await act(() => client.editCharter(body));
    editing.value = false;
    selected.value = "draft";
  } catch {}
}
async function sendAnswers() {
  const list = Object.entries(answers.value)
    .filter(([, a]) => a.trim())
    .map(([id, answer]) => ({ id: Number(id), answer }));
  if (!list.length) return;
  try {
    await act(() => client.answer(list));
    answers.value = {};
  } catch {}
}
const approve = () => act(() => client.approve()).catch(() => {});
const retry = () => act(() => client.retryCharter()).catch(() => {});
async function replaceBrief() {
  briefText.value = (await client.brief()).brief ?? "";
  replacingBrief.value = true;
}

// Proposals of the knowledge review (v1.5): open ones first, then the latest decided.
const knowledge = ref<KnowledgeView>();
const loadKnowledge = async () => {
  try {
    knowledge.value = await client.knowledge();
  } catch {
    // Without the knowledge plugin the section stays hidden.
  }
};
onMounted(loadKnowledge);
const proposals = computed(() => {
  const all = knowledge.value?.proposals ?? [];
  return [...all.filter((p) => p.status === "proposed"), ...all.filter((p) => p.status !== "proposed").slice(0, 5)];
});
const reviewing = ref(false);
async function reviewNow() {
  reviewing.value = true;
  try {
    await client.runKnowledgeReview();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await loadKnowledge();
      if (!knowledge.value?.running) break;
    }
  } finally {
    reviewing.value = false;
  }
}
</script>

<template>
  <div class="charter">
    <BriefScreen v-if="replacingBrief" :initial="briefText" replacing @done="replacingBrief = false" />
    <template v-else-if="view">
      <div class="charter-head">
        <h2>Charter</h2>
        <select v-model="selected" aria-label="Charter version">
          <option value="draft">{{ view.draft ? "Current draft" : "In force" }}</option>
          <option v-for="v in view.versions" :key="v.version" :value="v.version">Version {{ v.version }}</option>
        </select>
        <span class="spacer" />
        <button class="ghost" :disabled="running" @click="replaceBrief">Replace brief</button>
        <button class="ghost" :disabled="running || !shown || editing" @click="startEdit">Edit</button>
        <button class="primary" :disabled="running || !view.draft || editing" @click="approve">
          Approve{{ view.draft ? ` as v${(view.approved?.version ?? 0) + 1}` : "" }}
        </button>
      </div>

      <div v-if="running" class="notice">The research desk is drafting the charter…</div>
      <div v-if="failed" class="notice warn">
        Drafting failed: {{ view.run?.reason }}.
        <button class="ghost" @click="retry">Retry</button>
        or edit the charter yourself.
      </div>
      <p v-if="store.error" class="error">{{ store.error }}</p>

      <section v-if="openQuestions.length && !running" class="questions">
        <h3>The research desk asks</h3>
        <label v-for="q in openQuestions" :key="q.id" class="question">
          <span>{{ q.text }}</span>
          <input v-model="answers[q.id]" type="text" maxlength="2000" placeholder="Your answer" />
        </label>
        <button class="primary" @click="sendAnswers">Send answers and revise</button>
      </section>

      <section v-if="editing && draft" class="edit">
        <h3>Research questions</h3>
        <div v-for="(q, i) in draft.questions" :key="i" class="pair">
          <span class="muted">Q{{ i + 1 }}</span>
          <input v-model="q.text" type="text" maxlength="300" aria-label="Question" />
          <input v-model.number="q.weight" type="number" min="0.1" max="2" step="0.1" aria-label="Weight" />
          <button class="ghost" @click="draft.questions.splice(i, 1)">Remove</button>
        </div>
        <button class="ghost" @click="addQuestion">Add question</button>
        <h3>Search queries</h3>
        <div v-for="(q, i) in draft.queries" :key="i" class="pair">
          <input v-model="q.text" type="text" maxlength="120" aria-label="Query" />
          <input v-model.number="q.weight" type="number" min="0.1" max="2" step="0.1" aria-label="Weight" />
          <button class="ghost" @click="draft.queries.splice(i, 1)">Remove</button>
        </div>
        <button class="ghost" @click="addQuery">Add query</button>
        <h3>Concepts <span class="muted">(one per line)</span></h3>
        <textarea v-model="text.concepts" rows="4" />
        <h3>Sub-areas <span class="muted">(one per line)</span></h3>
        <textarea v-model="text.subAreas" rows="3" />
        <h3>Out of scope <span class="muted">(one per line)</span></h3>
        <textarea v-model="text.outOfScope" rows="3" />
        <div class="row">
          <span class="spacer" />
          <button class="ghost" @click="editing = false">Cancel</button>
          <button class="primary" @click="saveEdit">Save as draft</button>
        </div>
      </section>

      <section v-else-if="shown" class="view">
        <p class="muted">
          {{ shown.status === "draft" ? "Draft" : `Version ${shown.version}` }} · written by
          {{ shown.source === "agent" ? "the research desk" : "you" }}
        </p>
        <h3>Research questions</h3>
        <ol class="questions-list">
          <li v-for="q in shown.charter.questions" :key="q.id">
            <span class="muted">{{ q.id }}</span> <span>{{ q.text }}</span>
            <span v-if="q.weight !== 1" class="muted">· weight {{ q.weight }}</span>
          </li>
        </ol>
        <h3>Search queries</h3>
        <div class="chips">
          <span v-for="q in shown.charter.queries" :key="q.text" class="chip"
            >{{ q.text }}<small v-if="q.weight !== 1"> ×{{ q.weight }}</small></span
          >
        </div>
        <h3>Concepts</h3>
        <div class="chips">
          <span v-for="c in shown.charter.concepts" :key="c" class="chip">{{ c }}</span>
        </div>
        <h3>Sub-areas</h3>
        <div class="chips">
          <span v-for="c in shown.charter.subAreas" :key="c" class="chip">{{ c }}</span>
        </div>
        <template v-if="shown.charter.outOfScope.length">
          <h3>Out of scope</h3>
          <div class="chips">
            <span v-for="c in shown.charter.outOfScope" :key="c" class="chip out">{{ c }}</span>
          </div>
        </template>
      </section>
      <p v-else-if="!running" class="muted">No charter yet.</p>

      <section v-if="knowledge && view.approved" class="view" data-test="charter-proposals">
        <div class="row">
          <h3>Proposals</h3>
          <span class="spacer" />
          <button class="ghost small" :disabled="reviewing || knowledge.running" @click="reviewNow">
            {{ reviewing || knowledge.running ? "Reviewing…" : "Review now" }}
          </button>
        </div>
        <p class="muted small">
          Before each weekly digest the hub reads your judgments, reasons and comments and proposes changes to the
          charter with the evidence. Nothing changes until you approve; an approved change becomes the next version.
        </p>
        <KnowledgeProposals :proposals="proposals" @changed="loadKnowledge" />
        <template v-if="knowledge.finders.some((f) => f.proposed)">
          <h3>Question finders</h3>
          <p class="muted small">
            What each way of finding new questions brought: its proposals and how the questions you approved did.
          </p>
          <table class="small" data-test="finders">
            <thead>
              <tr>
                <th>Finder</th>
                <th>Proposed</th>
                <th>Approved</th>
                <th>Rejected</th>
                <th>👍/⭐ since</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in knowledge.finders" :key="f.finder" class="static">
                <td>{{ f.title }}</td>
                <td>{{ f.proposed }}</td>
                <td>{{ f.approved }}</td>
                <td>{{ f.rejected }}</td>
                <td>{{ f.liked }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>
    </template>
  </div>
</template>
