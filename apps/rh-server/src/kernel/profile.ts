// The core and full profiles (spec feature-profiles; design v2-0 D3): RH_PROFILE is applied once when it differs
// from the profile last applied. Core turns off the advanced plugins that are on and remembers them; full turns back
// on those that are still off. One commit, actor kernel. Undo reverses the plugin changes but keeps the profile, so
// the user's choice stands at the next start.
import type { Discovery } from "./registry.ts";
import { fullProfileOnly } from "./settings.ts";
import type { PluginState } from "./state.ts";

export async function applyProfile(
  state: PluginState,
  discovery: Discovery,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const profile = env.RH_PROFILE === "core" ? "core" : "full";
  if ((state.current().profile ?? "full") === profile) return;
  const advanced = [...discovery.plugins.values()]
    .filter((plugin) => plugin.builtin && fullProfileOnly(plugin.manifest))
    .map((plugin) => plugin.manifest.id);
  await state.update(
    (lockfile) => {
      lockfile.profile = profile;
      if (profile === "core") {
        const turnedOff = advanced.filter((id) => lockfile.plugins[id]?.enabled);
        for (const id of turnedOff) lockfile.plugins[id].enabled = false;
        lockfile.profileDisabled = turnedOff;
        return;
      }
      for (const id of lockfile.profileDisabled ?? [])
        if (lockfile.plugins[id] && !lockfile.plugins[id].enabled) lockfile.plugins[id].enabled = true;
      delete lockfile.profileDisabled;
    },
    `profile: ${profile}`,
    "kernel",
  );
}
