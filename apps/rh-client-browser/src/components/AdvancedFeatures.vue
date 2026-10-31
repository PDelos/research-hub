<script setup lang="ts">
// Settings → Advanced features (spec feature-profiles): the plugins the core profile leaves off, each with a switch.
// A switch is the ordinary plugin enable/disable, so it applies at once and is an undoable change in the history.
import { computed, ref } from "vue";
import { isRhError, type PluginSummary } from "@rh/sdk";
import { client } from "../store.ts";
import { usePlugins } from "../stores/plugins.ts";

const plugins = usePlugins();
const advanced = computed(() => plugins.plugins.filter((p) => p.advanced));
const busy = ref("");
const problem = ref("");
/** A plugin others depend on: turning it off asks first. */
const dependents = ref<{ id: string; names: string[] } | undefined>();

const isOn = (p: PluginSummary) => !["disabled", "incompatible"].includes(p.state);
/** The dependency a blocked plugin waits for ("needs rh.harness (disabled)"). */
const neededBy = (p: PluginSummary) => (p.state === "blocked" ? /needs (\S+)/.exec(p.reason ?? "")?.[1] : undefined);
const nameOf = (id: string) => plugins.plugins.find((p) => p.id === id)?.displayName ?? id;

async function change(work: () => Promise<unknown>, id: string) {
  busy.value = id;
  problem.value = "";
  try {
    await work();
  } catch (error) {
    if (isRhError(error) && Array.isArray(error.details)) dependents.value = { id, names: error.details as string[] };
    else problem.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = "";
    await plugins.refresh();
  }
}

const toggle = (p: PluginSummary) => change(() => client.setPluginEnabled(p.id, !isOn(p)), p.id);
const enableWithDependency = (p: PluginSummary, dependency: string) =>
  change(async () => {
    await client.setPluginEnabled(dependency, true);
    await client.setPluginEnabled(p.id, true);
  }, p.id);
const disableAll = (id: string) => {
  dependents.value = undefined;
  return change(() => client.setPluginEnabled(id, false, true), id);
};
</script>

<template>
  <section class="advanced">
    <h2>Advanced features</h2>
    <p class="muted">
      Off in the everyday (core) profile. Each one starts working as soon as you switch it on, and every switch can be
      undone from the plugin history.
    </p>
    <p v-if="problem" class="notice error">{{ problem }}</p>
    <div v-if="dependents" class="notice">
      {{ dependents.names.map(nameOf).join(", ") }} {{ dependents.names.length === 1 ? "needs" : "need" }}
      {{ nameOf(dependents.id) }}.
      <button class="ghost" @click="disableAll(dependents.id)">Turn them all off</button>
      <button class="ghost" @click="dependents = undefined">Keep it on</button>
    </div>
    <ul class="features">
      <li v-for="p in advanced" :key="p.id" :data-plugin="p.id">
        <label class="switch">
          <input
            type="checkbox"
            :checked="isOn(p)"
            :disabled="busy === p.id"
            :aria-label="`${p.displayName}: ${isOn(p) ? 'on' : 'off'}`"
            @change="toggle(p)"
          />
          <span class="name">{{ p.displayName }}</span>
        </label>
        <span class="muted small">{{ p.description }}</span>
        <span v-if="neededBy(p)" class="needs small">
          Needs {{ nameOf(neededBy(p)!) }}.
          <button class="ghost" :disabled="busy === p.id" @click="enableWithDependency(p, neededBy(p)!)">
            Turn on both
          </button>
        </span>
        <span v-else-if="p.state === 'failed'" class="needs small">Failed: {{ p.reason }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.features {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}
.features li {
  display: grid;
  gap: 0.15rem;
}
.switch {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.name {
  font-weight: 600;
}
.needs {
  color: var(--warn);
}
</style>
