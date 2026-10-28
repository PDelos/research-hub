// Built-in plugin rh.embedder-openrouter: the papers.embedder used by rh.papers. OpenRouter's embeddings endpoint
// with the configured model and size (settings `model` and `dims`, defaulting to RH_MODEL_EMBED and RH_EMBED_DIMS),
// or a deterministic fake offline and without a key. A settings change applies live: `embedder.changed` tells
// rh.papers to re-embed in the background.
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { PoliteHttp } from "../../src/papers/http.ts";
import { FakeEmbedder, OpenRouterEmbedder } from "../../src/representations/embed.ts";
import type { EmbedderExports } from "../rh.papers/main.ts";

export function activate(context: PluginContext): EmbedderExports {
  const host = hostOf(context);
  const { options } = host;
  const config = () => ({
    model: (context.savedSettings.model as string | undefined) ?? options.papers.embedModel,
    dims: (context.savedSettings.dims as number | undefined) ?? options.papers.embedDims,
  });
  context.onSettingsChange(() => context.rh.events.emit("embedder.changed", config()));
  return {
    config,
    createEmbedder: ({ ledger, model = config().model, dims = config().dims }) =>
      options.offline || !options.openrouterKey
        ? new FakeEmbedder(dims || 256, ledger)
        : new OpenRouterEmbedder({
            apiKey: options.openrouterKey,
            model,
            dims,
            ledger,
            http: new PoliteHttp({ fetch: options.paperFetch, log: host.log }),
          }),
  };
}
