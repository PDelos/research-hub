// Built-in plugin rh.provider-openrouter: the model catalog (OpenRouter models per job, or the scripted faux provider
// in offline mode) for the agents, and `rh.models.complete` for other plugins.
import type { Job, ModelCatalog } from "@rh/durable-agent";
import type { ModelsService } from "../../src/kernel/api.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";

export interface ResearchResult {
  text: string;
  citations: { url: string; title?: string }[];
  model: string;
  costUsd: number;
}

export class ResearchUnavailable extends Error {}

export interface ProviderExports {
  catalog: ModelCatalog;
  /**
   * A completion with web search (OpenRouter's web plugin, about $0.02 for 5 results) on the chat model: the
   * weekly upgrade's research. Unavailable offline (unless a test fetch is injected).
   */
  research(prompt: string, options?: { system?: string; maxResults?: number }): Promise<ResearchResult>;
}

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

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
  const research: ProviderExports["research"] = async (prompt, o = {}) => {
    if (host.offline && !host.options.paperFetch) throw new ResearchUnavailable("offline mode: no web search");
    const model = catalog.forJob("chat").modelId;
    const body = await context.rh.http.json<{
      choices?: {
        message?: {
          content?: string;
          annotations?: { type: string; url_citation?: { url: string; title?: string } }[];
        };
      }[];
      usage?: { cost?: number };
      error?: { message?: string };
    }>(CHAT_URL, {
      method: "POST",
      // Web search plus a reasoning model can take minutes; this runs in the background (weekly upgrade).
      timeoutMs: 300_000,
      budgetMs: 600_000,
      headers: {
        "content-type": "application/json",
        ...(host.options.openrouterKey ? { authorization: `Bearer ${host.options.openrouterKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        plugins: [{ id: "web", max_results: o.maxResults ?? 5 }],
        // Short answers from search results: little thinking needed (ignored by models without reasoning).
        reasoning: { effort: "low" },
        usage: { include: true },
        messages: [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: prompt }],
      }),
    });
    const message = body.choices?.[0]?.message;
    if (!message?.content) throw new Error(body.error?.message ?? "the research answer was empty");
    return {
      text: message.content,
      citations: (message.annotations ?? []).flatMap((a) =>
        a.url_citation
          ? [{ url: a.url_citation.url, ...(a.url_citation.title ? { title: a.url_citation.title } : {}) }]
          : [],
      ),
      model,
      costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
    };
  };
  return { catalog, research };
}
