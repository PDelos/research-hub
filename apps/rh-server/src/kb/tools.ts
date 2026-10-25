// The research desk's knowledge-base tools (spec knowledge-vault: Agent sees the index; design D5): the index is
// always in the desk's context; `search_kb` finds notes by keywords and `query_kb` reads one note in full.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { defineAppTool, toolError, toolText } from "@rh/durable-agent";
import type { KbIndex } from "./search.ts";
import type { Vault } from "./vault.ts";

export const INDEX_MAX_CHARS = 16_000;

export function kbTools(deps: () => { vault: Vault; index: KbIndex }): Extension {
  const search = defineAppTool({
    name: "search_kb",
    description:
      "Search the project's knowledge base (the Obsidian vault) by keywords; returns ranked notes with an excerpt.",
    returns: "Text: one line per note (name, title, excerpt).",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords" }),
      limit: Type.Optional(Type.Number({ description: "1 to 10, default 5" })),
    }),
    execute: async (args) => {
      const limit = Math.min(10, Math.max(1, Math.floor(args.limit ?? 5)));
      const hits = deps().index.search(args.query, limit);
      if (!hits.length) return toolText(`No notes match "${args.query}".`);
      return toolText(
        hits.map((h, i) => `${i + 1}. ${h.path} · ${h.title} · ${h.excerpt.replace(/\s+/g, " ")}`).join("\n"),
      );
    },
  });
  const query = defineAppTool({
    name: "query_kb",
    description:
      "Read one knowledge-base note in full by its name (for example lin-2023-evolutionary-scale-prediction-of-atomic) or path.",
    returns: "Text: the note's markdown.",
    parameters: Type.Object({
      stem: Type.String({ description: "Note name or path, as in the index or search results" }),
    }),
    execute: async (args) => {
      const { vault } = deps();
      const name = args.stem
        .trim()
        .replace(/^\[\[|\]\]$/g, "")
        .replace(/\.md$/, "");
      for (const rel of [`${name}.md`, `sources/${name}.md`, `concepts/${name}.md`, `questions/${name}.md`]) {
        if (rel.includes("..")) continue;
        const text = vault.read(rel);
        if (text !== undefined) return toolText(`${rel}\n\n${text}`);
      }
      return toolError(`No note named "${args.stem}".`, ["Use a name from the index or from search_kb."]);
    },
  });
  return defineExtension({
    name: "kb-tools",
    tools: [search, query],
    sections: [
      section("knowledge-base-index", () => {
        const { vault } = deps();
        const index = vault.exists() ? (vault.read("index.md") ?? "") : "";
        const papers = index.split("\n").filter((l) => l.startsWith("- [[")).length;
        if (!papers) return "## Knowledge base index\n\nThe knowledge base has no papers yet.";
        const body =
          index.length > INDEX_MAX_CHARS
            ? `${index.slice(0, INDEX_MAX_CHARS)}\n… (index cut; use search_kb for the rest)`
            : index;
        return `## Knowledge base index (${papers} papers; open notes with query_kb only for papers you cite)\n\n${body}`;
      }),
    ],
  });
}
