<script setup lang="ts">
// Charter proposals of the knowledge review (spec knowledge-loop: Approve, reject, undo): each change with its
// evidence; Approve makes it the next charter version, Reject takes an optional reason, Undo restores the charter
// before it while no later version exists.
import { ref } from "vue";
import type { KnowledgeProposal } from "@rh/sdk";
import { isRhError } from "@rh/sdk";
import { client, refreshProject } from "../store.ts";

const props = defineProps<{ proposals: KnowledgeProposal[] }>();
const emit = defineEmits<{ changed: [] }>();
const error = ref("");
const busy = ref(false);
const rejecting = ref<number>();
const reason = ref("");

const STATUS: Record<KnowledgeProposal["status"], string> = {
  proposed: "waiting for you",
  approved: "approved",
  rejected: "rejected",
  stale: "stale",
  undone: "undone",
};
const FINDER: Record<string, string> = {
  interests: "from your interests",
  "method-transfer": "same method, different problem",
  "missing-links": "missing link",
  "rising-topics": "rising topic",
};
const VERDICT_ICON: Record<string, string> = { star: "⭐", up: "👍", down: "👎" };
const verdict = (judgment: string | null) => VERDICT_ICON[judgment ?? ""] ?? "";

async function act(fn: () => Promise<unknown>) {
  error.value = "";
  busy.value = true;
  try {
    await fn();
    rejecting.value = undefined;
    reason.value = "";
    await refreshProject();
    emit("changed");
  } catch (e) {
    error.value = isRhError(e) ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
const approve = (id: number) => act(() => client.approveKnowledge(id));
const reject = (id: number) => act(() => client.rejectKnowledge(id, reason.value));
const undo = (id: number) => act(() => client.undoKnowledge(id));
</script>

<template>
  <div class="knowledge-proposals">
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!props.proposals.length" class="muted small">No charter proposals.</p>
    <ul class="replays">
      <li v-for="p in props.proposals" :key="p.id" :data-proposal="p.kind" :data-status="p.status">
        <div>
          <strong>{{ p.title }}</strong>
          <span class="badge" :class="{ 'verdict-better': p.status === 'approved' }">{{ STATUS[p.status] }}</span>
          <span v-if="p.appliedVersion" class="muted small"> · charter v{{ p.appliedVersion }}</span>
          <span v-if="p.finder" class="badge" :title="`Found by ${p.finder}`">{{ FINDER[p.finder] ?? p.finder }}</span>
        </div>
        <div class="small">
          {{ p.evidence.summary
          }}<span v-if="p.evidence.score !== undefined" class="muted">
            · promise {{ Math.round(p.evidence.score * 100) }}%</span
          >
        </div>
        <ul v-if="p.evidence.papers.length" class="small muted evidence">
          <li v-for="paper in p.evidence.papers" :key="paper.id">
            {{ verdict(paper.verdict) }} {{ paper.title
            }}<template v-if="paper.reason"> — “{{ paper.reason }}”</template>
          </li>
        </ul>
        <p v-if="p.reason" class="small muted">
          {{ p.status === "rejected" ? "Your reason" : "Note" }}: {{ p.reason }}
        </p>
        <div v-if="p.status === 'proposed'" class="row">
          <button class="primary" :disabled="busy" @click="approve(p.id)">Approve</button>
          <button v-if="rejecting !== p.id" class="ghost" :disabled="busy" @click="rejecting = p.id">Reject</button>
          <form v-else class="comment-form" @submit.prevent="reject(p.id)">
            <input v-model="reason" aria-label="Why not (optional)" placeholder="Why not? (optional)" />
            <button class="ghost" type="submit" :disabled="busy">Reject</button>
          </form>
        </div>
        <div v-else-if="p.status === 'approved'" class="row">
          <button class="ghost small" :disabled="busy" @click="undo(p.id)">Undo</button>
        </div>
      </li>
    </ul>
  </div>
</template>
