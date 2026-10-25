// The research desk's search_papers tool (spec paper-sources: Paper search from chat; design D8). The search runs
// once per tool call (memoized), so a replay after a crash neither searches again nor changes the answer.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { defineAppTool, once, toolError, toolText } from "@rh/durable-agent";
import type { Paper } from "./store.ts";
import type { PaperService } from "./service.ts";

export const SEARCH_PAPERS_MAX = 10;
export const SEARCH_PAPERS_DEFAULT = 5;

/** Memoized as JSON text, so a replay returns exactly the first answer. */
interface Memo {
  ids: number[];
  sources: { source: string; status: string; count: number; error?: string }[];
  error?: string;
}

export function paperTools(papers: () => PaperService): Extension {
  const search = defineAppTool({
    name: "search_papers",
    description: `Search arXiv, OpenAlex and Europe PMC (incl. bioRxiv/medRxiv) for papers; results are stored in the project. At most ${SEARCH_PAPERS_MAX} results per call.`,
    returns:
      "Text: one line per paper (title, year, venue or server, citations, sources, link) and which sources answered.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms, at most 200 characters; quote phrases" }),
      since: Type.Optional(Type.String({ description: "Only papers published on or after this date (YYYY-MM-DD)" })),
      limit: Type.Optional(
        Type.Number({ description: `1 to ${SEARCH_PAPERS_MAX} results, default ${SEARCH_PAPERS_DEFAULT}` }),
      ),
    }),
    execute: async (args, api, ctx) => {
      const query = args.query.trim();
      const limit = args.limit ?? SEARCH_PAPERS_DEFAULT;
      const problems: string[] = [];
      if (!query) problems.push("query is empty");
      if (query.length > 200) problems.push(`query has ${query.length} characters, at most 200 allowed`);
      if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_PAPERS_MAX)
        problems.push(
          `limit ${args.limit} is not allowed: at most ${SEARCH_PAPERS_MAX} results per call (1 to ${SEARCH_PAPERS_MAX})`,
        );
      if (args.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.since))
        problems.push(`since must be YYYY-MM-DD, got "${args.since}"`);
      if (problems.length)
        return toolError(`Not searched: ${problems.join("; ")}.`, [
          `Call search_papers again with limit 1 to ${SEARCH_PAPERS_MAX} and a short query.`,
        ]);

      const memo = JSON.parse(
        await once<string>(api, "search", ctx, async () => {
          let value: Memo;
          try {
            const result = await papers().find({ query, since: args.since, limit });
            value = {
              ids: result.papers.map((p) => p.id),
              sources: result.sources.map(({ source, status, count, error }) => ({
                source,
                status,
                count,
                ...(error ? { error } : {}),
              })),
            };
          } catch (error) {
            value = { ids: [], sources: [], error: error instanceof Error ? error.message : String(error) };
          }
          return JSON.stringify(value);
        }),
      ) as Memo;
      if (memo.error)
        return toolError(`The search failed: ${memo.error}.`, ["Tell the user the search failed and why."]);
      const found = memo.ids.map((id) => papers().store.get(id)).filter((p): p is Paper => !!p);
      const status = memo.sources
        .map((s) =>
          s.status === "ok"
            ? `${s.source} ${s.count}`
            : s.status === "failed"
              ? `${s.source} failed (${s.error})`
              : `${s.source} skipped`,
        )
        .join(", ");
      if (!found.length) return toolText(`No papers found for "${query}". Sources: ${status}.`, { ids: [] });
      const lines = found.map((p, i) => `${i + 1}. ${formatPaper(p)}`);
      return toolText(
        `${found.length} papers for "${query}" (stored in the project):\n${lines.join("\n")}\nSources: ${status}.`,
        { ids: memo.ids },
      );
    },
  });
  return defineExtension({ name: "paper-tools", tools: [search] });
}

/** One line: title (year) · venue or server · citations · sources · link. */
export function formatPaper(p: Paper): string {
  const where = p.venue ?? p.server ?? "unknown venue";
  const link = p.ids.doi ? `https://doi.org/${p.ids.doi}` : (p.url ?? p.oaUrl ?? "");
  const parts = [
    `${p.title} (${p.year ?? "n.d."})`,
    where,
    p.citedByCount !== undefined ? `${p.citedByCount} citations` : "citations unknown",
    `sources: ${p.sources.join(", ")}`,
    ...(p.retracted ? ["RETRACTED"] : []),
    link,
  ];
  return parts.filter(Boolean).join(" · ");
}
