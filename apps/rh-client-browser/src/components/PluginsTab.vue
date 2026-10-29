<script setup lang="ts">
// The Plugins tab (spec plugin-system: Plugins view): every plugin with its state, version, contributions,
// permissions, settings and history; install (approve what it asks for first), enable, disable, configure,
// uninstall and roll back.
import { computed, onMounted, ref, watch } from "vue";
import {
  isRhError,
  type PluginDetails,
  type PluginHistoryEntry,
  type PluginInstallPlan,
  type SlotView,
  type SourceAttribution,
} from "@rh/sdk";
import { client } from "../store.ts";
import { usePlugins } from "../stores/plugins.ts";
import PluginSettingsForm from "./PluginSettingsForm.vue";

const plugins = usePlugins();
const selected = ref<string>();
const details = ref<PluginDetails>();
const history = ref<PluginHistoryEntry[]>([]);
const error = ref("");
const problems = ref<string[]>([]);
const dependents = ref<string[]>([]);
const deleteData = ref(false);
const installing = ref(false);
const source = ref({ kind: "git" as "git" | "folder", value: "" });
const plan = ref<PluginInstallPlan>();

const topics = [
  { id: "finding", title: "Finding papers" },
  { id: "understanding", title: "Understanding papers" },
  { id: "ranking", title: "Ranking" },
  { id: "knowledge", title: "Knowledge base" },
  { id: "agents", title: "Agents and models" },
  { id: "integrations", title: "Integrations" },
  { id: "interface", title: "Interface" },
] as const;
const slots = ref<SlotView[]>([]);
const attribution = ref<SourceAttribution[]>([]);
const running = ref("");
const slotsByTopic = (topic: string) => slots.value.filter((s) => s.topic === topic);
const byKind = (kind: string, topic: string) => plugins.plugins.filter((p) => p.kind === kind && p.topic === topic);
const usage = (pluginId: string) => {
  const rows = attribution.value.filter((a) => a.pluginId === pluginId);
  if (!rows.length) return "";
  const cards = rows.reduce((n, r) => n + r.cards, 0);
  const liked = rows.reduce((n, r) => n + r.liked, 0);
  return `${cards} cards, ${liked} liked (30 days)`;
};
async function loadGroups() {
  [slots.value, attribution.value] = await Promise.all([client.slots(), client.attribution(30)]);
}
async function runBenchmark(slot: string) {
  running.value = slot;
  try {
    await run(() => client.runBenchmark(slot));
    await loadGroups();
  } catch {
    // shown by run()
  } finally {
    running.value = "";
  }
}
async function toggle(id: string, enabled: boolean) {
  selected.value = id;
  await setEnabled(enabled);
}
const stateLabel: Record<string, string> = {
  active: "active",
  activating: "starting",
  inactive: "ready",
  disabled: "disabled",
  failed: "failed",
  incompatible: "incompatible",
  blocked: "blocked",
};

async function load(id = selected.value) {
  error.value = "";
  if (!id) return;
  try {
    details.value = await client.plugin(id);
  } catch (failure) {
    details.value = undefined;
    error.value = failure instanceof Error ? failure.message : String(failure);
  }
}
async function loadHistory() {
  history.value = await client.pluginHistory(30);
}
function select(id: string) {
  selected.value = id;
  dependents.value = [];
  deleteData.value = false;
  void load(id);
}
onMounted(async () => {
  void loadGroups();
  await plugins.refresh();
  await loadHistory();
});
// Follow state changes from the stream while a plugin is open.
watch(
  () => plugins.plugins.find((p) => p.id === selected.value)?.state,
  () => void load(),
);

async function run(action: () => Promise<unknown>) {
  error.value = "";
  problems.value = [];
  try {
    await action();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
    if (isRhError(failure) && Array.isArray(failure.details)) problems.value = failure.details as string[];
    throw failure;
  } finally {
    await plugins.refresh();
    await loadHistory();
    await load();
  }
}

async function setEnabled(enabled: boolean, cascade = false) {
  const id = selected.value!;
  try {
    await run(() => client.setPluginEnabled(id, enabled, cascade));
    dependents.value = [];
  } catch (failure) {
    // Others depend on it: ask before disabling them too.
    if (isRhError(failure) && failure.code === "conflict" && Array.isArray(failure.details)) {
      dependents.value = failure.details as string[];
      error.value = "";
      problems.value = [];
    }
  }
}
async function uninstall() {
  const id = selected.value!;
  await run(() => client.uninstallPlugin(id, deleteData.value)).catch(() => undefined);
  selected.value = undefined;
  details.value = undefined;
}
async function check() {
  plan.value = undefined;
  const value = source.value.value.trim();
  if (!value) return;
  await run(async () => {
    plan.value = await client.prepareInstall(source.value.kind === "git" ? { git: value } : { folder: value });
  }).catch(() => undefined);
}
async function approve() {
  const approved = plan.value!;
  await run(() => client.approveInstall(approved.planId)).catch(() => undefined);
  plan.value = undefined;
  installing.value = false;
  source.value.value = "";
  select(approved.id);
}
async function cancel() {
  if (plan.value) await client.cancelInstall(plan.value.planId);
  plan.value = undefined;
}
async function restore(entry: PluginHistoryEntry) {
  await run(() => client.rollbackPlugins(entry.id)).catch(() => undefined);
}
const time = (iso: string) => new Date(iso).toLocaleString();
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const listOf = (items: string[] | undefined) => (items?.length ? items.join(", ") : "none");
</script>

<template>
  <div class="plugins">
    <div class="plugins-head">
      <h2>Plugins</h2>
      <span class="muted small">kernel API {{ plugins.kernelApi }}</span>
      <span class="spacer" />
      <button class="ghost" @click="installing = !installing">{{ installing ? "Close" : "Install a plugin" }}</button>
    </div>

    <section v-if="installing" class="install">
      <form class="row" @submit.prevent="check">
        <select v-model="source.kind" aria-label="Source">
          <option value="git">Git URL</option>
          <option value="folder">Folder on the server</option>
        </select>
        <input
          v-model="source.value"
          :placeholder="source.kind === 'git' ? 'https://github.com/…/plugin.git' : '/path/to/plugin'"
          aria-label="Plugin location"
        />
        <button class="primary" type="submit">Check</button>
      </form>
      <div v-if="plan" class="plan">
        <h3>
          {{ plan.displayName }} <span class="muted">{{ plan.id }} {{ plan.version }}</span>
          <span v-if="plan.replaces" class="muted">(replaces {{ plan.replaces }})</span>
        </h3>
        <p v-if="plan.description">{{ plan.description }}</p>
        <h4>It asks for</h4>
        <ul class="perms">
          <li>Network: {{ listOf(plan.permissions.network) }}</li>
          <li>Files: {{ listOf(plan.permissions.files) }}</li>
          <li>Secrets: {{ listOf(plan.permissions.secrets) }}</li>
          <li>
            Budget:
            {{
              plan.permissions.budgetUsdPerDay !== undefined
                ? `$${plan.permissions.budgetUsdPerDay}/day`
                : "no paid calls"
            }}
          </li>
        </ul>
        <h4>It adds</h4>
        <ul class="perms">
          <li v-if="plan.contributions.tabs.length">
            Tabs: {{ plan.contributions.tabs.map((t) => t.title).join(", ") }}
          </li>
          <li v-if="plan.contributions.chatTools.length">
            Chat tools: {{ plan.contributions.chatTools.map((t) => t.name).join(", ") }}
          </li>
          <li v-if="plan.contributions.commands.length">Commands: {{ plan.contributions.commands.length }}</li>
          <li v-for="(items, point) in plan.contributions.points" :key="point">
            {{ point }}: {{ items.map((i) => i.id).join(", ") }}
          </li>
          <li v-if="plan.contributions.processes.length">
            Processes: {{ plan.contributions.processes.map((p) => p.id).join(", ") }}
          </li>
        </ul>
        <div class="row">
          <button class="primary" @click="approve">Approve and install</button>
          <button class="ghost" @click="cancel">Cancel</button>
        </div>
      </div>
    </section>

    <p v-if="error" class="error">{{ error }}</p>
    <ul v-if="problems.length" class="error">
      <li v-for="p in problems" :key="p">{{ p }}</li>
    </ul>

    <div class="plugins-body" :class="{ single: !details }">
      <div class="plugin-groups">
        <section class="plugin-group-kind" data-group="slots">
          <h3>Slots <span class="muted small">one active each; replaced only when a benchmark says so</span></h3>
          <template v-for="topic in topics" :key="'s' + topic.id">
            <div v-if="slotsByTopic(topic.id).length" class="topic">
              <h4>{{ topic.title }}</h4>
              <article v-for="slot in slotsByTopic(topic.id)" :key="slot.id" class="slot-card" :data-slot="slot.id">
                <div class="row">
                  <strong>{{ slot.title }}</strong>
                  <span class="spacer" />
                  <button
                    class="ghost small"
                    :disabled="!slot.preset || running === slot.id"
                    :title="slot.preset ? `Runs ${slot.preset.title}` : 'No benchmark preset yet'"
                    @click="runBenchmark(slot.id)"
                  >
                    {{ running === slot.id ? "Running…" : "Run benchmark" }}
                  </button>
                </div>
                <p class="muted small">{{ slot.description }}</p>
                <p class="small">
                  Active:
                  <a href="#" @click.prevent="select(slot.active.pluginId)">{{ slot.active.name }}</a>
                  <template v-if="slot.alternatives.length">
                    · alternatives: {{ slot.alternatives.map((a) => a.name).join(", ") }}</template
                  >
                </p>
                <p class="small">
                  Preset: {{ slot.preset ? `${slot.preset.title} (${slot.preset.metric})` : "planned" }}
                  <template v-if="slot.last">
                    · last: <strong>{{ slot.last.result.label }}</strong> ({{ day(slot.last.createdAt) }}, ${{
                      slot.last.costUsd.toFixed(4)
                    }})</template
                  >
                </p>
              </article>
            </div>
          </template>
        </section>

        <section class="plugin-group-kind" data-group="addons">
          <h3>Add-ons <span class="muted small">add things; turn on or off</span></h3>
          <template v-for="topic in topics" :key="'a' + topic.id">
            <div v-if="byKind('addon', topic.id).length" class="topic">
              <h4>{{ topic.title }}</h4>
              <ul class="plugin-rows">
                <li
                  v-for="p in byKind('addon', topic.id)"
                  :key="p.id"
                  :data-plugin="p.id"
                  :class="{ on: p.id === selected }"
                >
                  <a href="#" @click.prevent="select(p.id)">{{ p.displayName }}</a>
                  <span class="muted small">{{ usage(p.id) }}</span>
                  <span class="spacer" />
                  <span class="state" :class="p.state">{{ stateLabel[p.state] }}</span>
                  <button v-if="p.state === 'disabled'" class="ghost small" @click="toggle(p.id, true)">Turn on</button>
                  <button v-else class="ghost small" @click="toggle(p.id, false)">Turn off</button>
                </li>
              </ul>
            </div>
          </template>
        </section>

        <section class="plugin-group-kind" data-group="preferences">
          <h3>Preferences <span class="muted small">your choice, no benchmark</span></h3>
          <ul class="plugin-rows">
            <li v-for="p in plugins.plugins.filter((x) => x.kind === 'preference')" :key="p.id" :data-plugin="p.id">
              <a href="#" @click.prevent="select(p.id)">{{ p.displayName }}</a>
              <span class="spacer" />
              <span class="state" :class="p.state">{{ stateLabel[p.state] }}</span>
            </li>
          </ul>
          <p class="muted small">
            The Knowledge base viewer is chosen under Core → Knowledge base → Settings (Automatic by default).
          </p>
        </section>

        <details class="plugin-group-kind" data-group="core">
          <summary>
            <h3>
              Core
              <span class="muted small"
                >cannot be changed ({{ plugins.plugins.filter((x) => x.kind === "core").length }})</span
              >
            </h3>
          </summary>
          <ul class="plugin-rows">
            <li v-for="p in plugins.plugins.filter((x) => x.kind === 'core')" :key="p.id" :data-plugin="p.id">
              <a href="#" @click.prevent="select(p.id)">{{ p.displayName }}</a>
              <span class="spacer" />
              <span class="state" :class="p.state">{{ stateLabel[p.state] }}</span>
            </li>
          </ul>
        </details>
      </div>

      <article v-if="details" class="plugin-details">
        <h3>
          {{ details.displayName }} <span class="muted small">{{ details.id }} {{ details.version }}</span>
        </h3>
        <p v-if="details.description">{{ details.description }}</p>
        <p>
          <span class="state" :class="details.state">{{ stateLabel[details.state] }}</span>
          <span v-if="details.reason" class="muted"> — {{ details.reason }}</span>
        </p>
        <div class="row">
          <button v-if="details.state === 'disabled'" class="primary" @click="setEnabled(true)">Enable</button>
          <button v-else-if="!details.required" class="ghost" @click="setEnabled(false)">Disable</button>
          <span v-else class="muted small">The hub needs this plugin: it can be configured, not disabled.</span>
          <template v-if="!details.builtin">
            <label class="check small"><input v-model="deleteData" type="checkbox" /> also delete its data</label>
            <button class="ghost danger" @click="uninstall">Uninstall</button>
          </template>
        </div>
        <div v-if="dependents.length" class="notice">
          {{ dependents.join(", ") }} {{ dependents.length === 1 ? "depends" : "depend" }} on {{ details.displayName }}.
          <button class="ghost" @click="setEnabled(false, true)">Disable them too</button>
          <button class="ghost" @click="dependents = []">Keep it</button>
        </div>
        <ul v-if="details.problems.length" class="warn small">
          <li v-for="p in details.problems" :key="p">{{ p }}</li>
        </ul>

        <h4>Contributes</h4>
        <ul class="perms">
          <li v-if="details.contributions.tabs.length">
            Tabs: {{ details.contributions.tabs.map((t) => t.title).join(", ") }}
          </li>
          <li v-if="details.contributions.chatTools.length">
            Chat tools: {{ details.contributions.chatTools.map((t) => t.name).join(", ") }}
          </li>
          <li v-if="details.contributions.commands.length">
            Commands: {{ details.contributions.commands.map((c) => c.title).join(", ") }}
          </li>
          <li v-if="details.contributions.jevCommands.length">
            Jev commands: {{ details.contributions.jevCommands.join(", ") }}
          </li>
          <li v-if="details.contributions.prompts.length">
            Agents: {{ details.contributions.prompts.map((p) => p.agent).join(", ") }}
          </li>
          <li v-if="details.contributions.processes.length">
            Processes: {{ details.contributions.processes.map((p) => p.title ?? p.id).join(", ") }}
          </li>
          <li v-for="(decl, point) in details.contributions.extensionPoints" :key="point">
            Offers {{ point }} ({{ decl.cardinality === "one" ? "one active" : "many" }})
          </li>
          <li v-for="(items, point) in details.contributions.points" :key="point">
            {{ point }}: {{ items.map((i) => i.title ?? i.id).join(", ") }}
          </li>
        </ul>
        <h4>Permissions</h4>
        <ul class="perms">
          <li>Network: {{ listOf(details.permissions.network) }}</li>
          <li>Files: {{ listOf(details.permissions.files) }}</li>
          <li>Secrets: {{ listOf(details.permissions.secrets) }}</li>
          <li v-if="details.permissions.budgetUsdPerDay !== undefined">
            Budget: ${{ details.permissions.budgetUsdPerDay }}/day
          </li>
        </ul>
        <p class="muted small">
          Needs kernel API {{ details.engines
          }}<template v-if="Object.keys(details.dependencies).length">
            · depends on {{ Object.keys(details.dependencies).join(", ") }}</template
          ><template v-if="details.dependents.length"> · needed by {{ details.dependents.join(", ") }}</template>
        </p>
        <template v-if="Object.keys(details.settings.properties).length">
          <h4>Settings</h4>
          <PluginSettingsForm
            :plugin-id="details.id"
            :properties="details.settings.properties"
            :values="details.settings.values"
            @saved="load()"
          />
        </template>
        <template v-if="details.history.length">
          <h4>Changes</h4>
          <ul class="history small">
            <li v-for="h in details.history" :key="h.id">
              {{ time(h.time) }} · {{ h.message }} <span class="muted">({{ h.actor }})</span>
            </li>
          </ul>
        </template>
      </article>
    </div>

    <h3>History</h3>
    <p class="muted small">Every change to the plugins is recorded. Restoring a state re-applies it as a new change.</p>
    <ul class="history">
      <li v-for="(h, i) in history" :key="h.id">
        <span
          >{{ time(h.time) }} · {{ h.message }} <span class="muted">({{ h.actor }})</span></span
        >
        <button v-if="i > 0" class="ghost small" @click="restore(h)">Restore this state</button>
      </li>
    </ul>
    <template v-if="plugins.invalid.length">
      <h3>Not loaded</h3>
      <ul class="error small">
        <li v-for="i in plugins.invalid" :key="i.dir">{{ i.dir }}: {{ i.problems.join("; ") }}</li>
      </ul>
    </template>
  </div>
</template>
