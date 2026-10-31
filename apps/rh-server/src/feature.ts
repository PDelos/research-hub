// Advanced features behind optional plugins (spec feature-profiles: Feature off is not an error): a route that needs
// one reaches its exports here, and a disabled plugin answers 409 feature_off with its id instead of failing.
import { ApiFault } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { PluginUnavailable } from "./kernel/lifecycle.ts";

export async function featureExports<T>(hub: Hub, pluginId: string): Promise<T> {
  try {
    return await hub.project.plugins.exportsOf<T>(pluginId);
  } catch (error) {
    if (error instanceof PluginUnavailable)
      throw new ApiFault("feature_off", `${pluginId} is off: switch it on in Settings → Advanced features`, {
        plugin: pluginId,
      });
    throw error;
  }
}
