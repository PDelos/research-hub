// Built-in plugin rh.provider-openrouter: the model catalog (OpenRouter models per job, or the scripted faux provider
// in offline mode) for the agents, and `rh.models.complete` for other plugins.
import type { Job, ModelCatalog } from "@rh/durable-agent";
import type { ModelsService } from "../../src/kernel/api.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";

export interface ProviderExports {
  catalog: ModelCatalog;
}

export function activate(context: PluginContext): ProviderExports {
  const host = hostOf(context);
  const catalog = host.options.catalog;
  const models: ModelsService = {
    async complete(request) {
      const ref = request.model ? catalog.ref(request.model) : catalog.forJob((request.job ?? "chat") as Job);
      const model = catalog.models.getModel(ref.provider, ref.modelId);
      if (!model) throw new Error(`model ${ref.modelId} is not available from ${ref.provider}`);
      const message = await catalog.models.completeSimple(
        model,
        {
          ...(request.system ? { systemPrompt: request.system } : {}),
          messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
        },
        request.maxTokens ? { maxTokens: request.maxTokens } : {},
      );
      if (message.stopReason === "error") throw new Error(message.errorMessage ?? `${ref.modelId} failed`);
      const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
      return { text, model: ref.modelId, costUsd: message.usage.cost.total ?? 0 };
    },
  };
  host.services.providers.models = models;
  context.subscriptions.push({
    dispose: () => {
      if (host.services.providers.models === models) host.services.providers.models = undefined;
    },
  });
  return { catalog };
}
