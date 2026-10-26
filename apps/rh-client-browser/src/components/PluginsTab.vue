<script setup lang="ts">
// The Plugins tab (spec plugin-system: Plugins view): every plugin with its state, version, contributions,
// permissions, settings and history; install (approve what it asks for first), enable, disable, configure,
// uninstall and roll back.
import { computed, onMounted, ref, watch } from "vue";
import { isRhError, type PluginDetails, type PluginHistoryEntry, type PluginInstallPlan } from "@rh/sdk";
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

const sorted = computed(() =>
  plugins.plugins.toSorted(
    (a, b) => Number(a.builtin) - Number(b.builtin) || a.displayName.localeCompare(b.displayName),
  ),
);
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
  } catch (e) {
    details.value = undefined;
    error.value = e instanceof Error ? e.message : String(e);
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
  await plugins.refresh();
  await loadHistory();
});
// Follow state changes from the stream while a plugin is open.
watch(
  () => plugins.plugins.find((p) => p.id === selected.value)?.state,
  () => void load(),
);

async function run(fn: () => Promise<unknown>) {
  error.value = "";
  problems.value = [];
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (isRhError(e) && Array.isArray(e.details)) problems.value = e.details as string[];
    throw e;
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
  } catch (e) {
    // Others depend on it: ask before disabling them too.
    if (isRhError(e) && e.code === "conflict" && Array.isArray(e.details)) {
      dependents.value = e.details as string[];
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
  const p = plan.value!;
  await run(() => client.approveInstall(p.planId)).catch(() => undefined);
  plan.value = undefined;
  installing.value = false;
  source.value.value = "";
  select(p.id);
}
async function cancel() {
  if (plan.value) await client.cancelInstall(plan.value.planId);
  plan.value = undefined;
}
async function restore(entry: PluginHistoryEntry) {
  await run(() => client.rollbackPlugins(entry.id)).catch(() => undefined);
}
const time = (iso: string) => new Date(iso).toLocaleString();
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

    <div class="plugins-body">
      <table class="plugin-list">
        <tbody>
          <tr
            v-for="p in sorted"
            :key="p.id"
            :class="{ on: p.id === selected }"
            :data-plugin="p.id"
            @click="select(p.id)"
          >
            <td>
              <strong>{{ p.displayName }}</strong>
              <div class="muted small">{{ p.id }} {{ p.version }}{{ p.builtin ? " · built in" : "" }}</div>
            </td>
            <td>
              <span class="state" :class="p.state">{{ stateLabel[p.state] }}</span>
            </td>
          </tr>
        </tbody>
      </table>

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
      <p v-else class="empty muted">Select a plugin to see what it adds, what it may do, and its settings.</p>
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
