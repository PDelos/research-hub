// A plugin's run state as the kernel reports it: whether an activation event wakes it, why a plugin that is not
// running is held back, and what the Plugins tab shows as its problem.
import type { PluginRunState } from "@rh/sdk";

/** Whether `event` is one of the plugin's activation events ("*" means at start-up). */
export function matches(events: string[], event: string): boolean {
  return events.includes(event) || (event === "onStartup" && events.includes("*"));
}

/** What the Plugins tab shows as a plugin's problem, if any. */
export function problemOf(record: { plugin: { incompatible?: string }; state: string; reason?: string }): {
  problem?: string;
} {
  if (record.plugin.incompatible) return { problem: record.plugin.incompatible };
  if (record.state === "failed") return { problem: `failed: ${record.reason}` };
  return {};
}

/** The state of a plugin that is not running, from why it is held back (if it is). */
export function idleState(reason: string | undefined, incompatible: boolean): [PluginRunState, string | undefined] {
  if (reason === undefined) return ["inactive", undefined];
  if (reason === "disabled") return ["disabled", undefined];
  return [incompatible ? "incompatible" : "blocked", reason];
}
