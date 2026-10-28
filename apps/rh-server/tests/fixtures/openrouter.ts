// A fake OpenRouter for the weekly upgrade's tests: the embeddings catalog and web-search completions. Everything
// else falls through to the offline paper fetch.
import { offlinePaperFetch } from "../../src/papers/offline.ts";

export interface FakeOpenRouter {
  fetch: typeof fetch;
  research: any[];
  /** What the next web-search completion answers. */
  answer: string;
}

export function fakeOpenRouter(
  models: { id: string; prompt: string; created: number; dimensions?: boolean; context?: number }[],
): FakeOpenRouter {
  const offline = offlinePaperFetch();
  const state: FakeOpenRouter = { research: [], answer: "[]", fetch: undefined as never };
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://openrouter.ai/api/v1/embeddings/models")
      return Response.json({
        data: models.map((m) => ({
          id: m.id,
          name: m.id,
          created: m.created,
          context_length: m.context ?? 8192,
          pricing: { prompt: m.prompt },
          supported_parameters: m.dimensions ? ["dimensions"] : [],
          description: `${m.id} embeds text`,
        })),
      });
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      state.research.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [
          {
            message: {
              content: state.answer,
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.org/leaderboard", title: "A leaderboard" },
                },
              ],
            },
          },
        ],
        usage: { cost: 0.02 },
      });
    }
    return offline(input, init);
  }) as typeof fetch;
  return state;
}
