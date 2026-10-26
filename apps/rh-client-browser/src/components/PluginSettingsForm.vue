<script setup lang="ts">
// A plugin's settings as a form generated from its JSON-schema properties; the server validates every change and
// names the setting and the rule when a value is refused.
import { computed, ref, watch } from "vue";
import { isRhError, type PluginSettingProperty } from "@rh/sdk";
import { client } from "../store.ts";
import { usePlugins } from "../stores/plugins.ts";

const props = defineProps<{
  pluginId: string;
  properties: Record<string, PluginSettingProperty>;
  values: Record<string, unknown>;
}>();
const emit = defineEmits<{ saved: [] }>();
const plugins = usePlugins();
const form = ref<Record<string, unknown>>({});
const problems = ref<string[]>([]);
const saved = ref("");
watch(
  () => props.values,
  (v) => (form.value = { ...v }),
  { immediate: true, deep: true },
);
/** Choices for a property: its enum, or the contributions to the extension point it selects (kb.viewer). */
const choices = computed(() => {
  const out: Record<string, { value: unknown; label: string }[]> = {};
  for (const [key, p] of Object.entries(props.properties)) {
    if (p.enum) out[key] = p.enum.map((v) => ({ value: v, label: String(v) }));
    else if (key === "kb.viewer")
      out[key] = (plugins.contributions?.viewer.options ?? []).map((o) => ({ value: o.id, label: o.title }));
  }
  return out;
});
const names: Record<string, string> = { "kb.viewer": "Knowledge base viewer" };
const label = (key: string) =>
  names[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

async function save() {
  problems.value = [];
  saved.value = "";
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(props.properties)) {
    const before = props.values[key];
    let value = form.value[key];
    const type = props.properties[key].type;
    if ((type === "integer" || type === "number") && typeof value === "string" && value.trim() !== "")
      value = Number(value);
    if (JSON.stringify(value) !== JSON.stringify(before)) changes[key] = value === "" ? null : value;
  }
  if (!Object.keys(changes).length) return void (saved.value = "Nothing changed.");
  try {
    await client.setPluginSettings(props.pluginId, changes);
    saved.value = "Saved.";
    await plugins.refresh();
    emit("saved");
  } catch (e) {
    problems.value =
      isRhError(e) && Array.isArray(e.details) ? (e.details as string[]) : [e instanceof Error ? e.message : String(e)];
  }
}
</script>

<template>
  <form class="plugin-settings" @submit.prevent="save">
    <label v-for="(p, key) in properties" :key="key" :class="{ check: p.type === 'boolean' }">
      <template v-if="p.type === 'boolean'">
        <input v-model="form[key]" type="checkbox" /> {{ label(String(key)) }}
      </template>
      <template v-else>
        <span>{{ label(String(key)) }}</span>
        <select v-if="choices[key]" v-model="form[key]">
          <option v-for="c in choices[key]" :key="String(c.value)" :value="c.value">{{ c.label }}</option>
        </select>
        <input
          v-else
          v-model="form[key]"
          :type="p.type === 'integer' || p.type === 'number' ? 'number' : 'text'"
          :min="p.minimum"
          :max="p.maximum"
        />
      </template>
      <small v-if="p.description || p.env" class="muted">
        {{ p.description }}<template v-if="p.env"> (default from {{ p.env }})</template>
      </small>
    </label>
    <div class="row">
      <button class="primary" type="submit">Save</button>
      <span class="muted">{{ saved }}</span>
    </div>
    <ul v-if="problems.length" class="error">
      <li v-for="p in problems" :key="p">{{ p }}</li>
    </ul>
  </form>
</template>
