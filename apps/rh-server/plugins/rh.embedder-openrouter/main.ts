// Built-in plugin rh.embedder-openrouter: the papers.embedder used by rh.papers. OpenRouter's embeddings endpoint
// with the configured model and dimensions, or a deterministic fake offline and without a key.
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { PoliteHttp } from "../../src/papers/http.ts";
import { FakeEmbedder, OpenRouterEmbedder } from "../../src/representations/embed.ts";
import type { EmbedderExports } from "../rh.papers/main.ts";

export function activate(context: PluginContext): EmbedderExports {
  const host = hostOf(context);
  const { options } = host;
  const { embedModel, embedDims } = options.papers;
  return {
    createEmbedder: ({ ledger, model = embedModel, dims = embedDims }) =>
      options.offline || !options.openrouterKey
        ? new FakeEmbedder(dims, ledger)
        : new OpenRouterEmbedder({
            apiKey: options.openrouterKey,
            model,
            dims,
            ledger,
            http: new PoliteHttp({ fetch: options.paperFetch, log: host.log }),
          }),
  };
}
