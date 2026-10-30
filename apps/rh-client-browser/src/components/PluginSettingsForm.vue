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
/** Object and array settings are edited as JSON. */
const json = ref<Record<string, string>>({});
const saved = ref("");
watch(
  () => props.values,
  // A choice that is not saved shows as "" (Automatic, for the viewer).
  (values) => {
    form.value = Object.fromEntries(Object.keys(props.properties).map((k) => [k, values[k] ?? ""]));
    json.value = Object.fromEntries(
      Object.keys(props.properties).map((k) => [k, values[k] === undefined ? "" : JSON.stringify(values[k], null, 1)]),
    );
  },
  { immediate: true, deep: true },
);
/** Choices for a property: its enum, or the contributions to the extension point it selects (kb.viewer). */
const choices = computed(() => {
  const out: Record<string, { value: unknown; label: string }[]> = {};
  for (const [key, p] of Object.entries(props.properties)) {
    if (p.enum) out[key] = p.enum.map((v) => ({ value: v, label: String(v) }));
    else if (key === "kb.viewer")
      out[key] = [
        { value: "", label: "Automatic (Obsidian when this image has it, else Library)" },
        ...(plugins.contributions?.viewer.options ?? []).map((o) => ({ value: o.id, label: o.title })),
      ];
  }
  return out;
});
const names: Record<string, string> = { "kb.viewer": "Knowledge base viewer" };
const label = (key: string) =>
  names[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** The value a field holds, as the setting's type: JSON fields parsed, numbers as numbers; "" means unset. */
function fieldValue(key: string): unknown {
  const type = props.properties[key].type;
  if (type === "object" || type === "array") {
    const text = json.value[key].trim();
    if (!text) return "";
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${key}: not valid JSON`);
    }
  }
  const value = form.value[key];
  const isNumber = type === "integer" || type === "number";
  return isNumber && typeof value === "string" && value.trim() !== "" ? Number(value) : value;
}

/** The settings that differ from the saved values (an emptied field becomes null, back to its default). */
function changedSettings(): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(props.properties)) {
    const value = fieldValue(key);
    if (JSON.stringify(value) !== JSON.stringify(props.values[key] ?? "")) changes[key] = value === "" ? null : value;
  }
  return changes;
}

const problemsOf = (error: unknown): string[] =>
  isRhError(error) && Array.isArray(error.details)
    ? (error.details as string[])
    : [error instanceof Error ? error.message : String(error)];

async function save() {
  problems.value = [];
  saved.value = "";
  let changes: Record<string, unknown>;
  try {
    changes = changedSettings();
  } catch (error) {
    problems.value = problemsOf(error);
    return;
  }
  if (!Object.keys(changes).length) return void (saved.value = "Nothing changed.");
  try {
    await client.setPluginSettings(props.pluginId, changes);
    saved.value = "Saved.";
    await plugins.refresh();
    emit("saved");
  } catch (error) {
    problems.value = problemsOf(error);
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
        <textarea
          v-else-if="p.type === 'object' || p.type === 'array'"
          v-model="json[key]"
          rows="3"
          spellcheck="false"
        />
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
