// Built-in add-on rh.mcp (spec mcp; design v1-9): read-only MCP tools over this project's knowledge, for outside
// agents. The /mcp route (src/routes-mcp.ts) builds a server per request from `server()`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { withinBudget } from "../../src/fulltext/parse.ts";
import type { CharterExports } from "../rh.charter/main.ts";
import type { FullTextExports } from "../rh.fulltext/main.ts";
import type { KbExports } from "../rh.kb/main.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import { VERSION } from "../../src/version.ts";

export const MAX_TEXT = 20_000;

export interface McpExports {
  server(): McpServer;
}

export function activate(context: PluginContext): McpExports {
  const host = hostOf(context);
  const { db } = host;
  const kb = context.exports["rh.kb"] as KbExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const { charters } = context.exports["rh.charter"] as CharterExports;
  const fulltext = context.exports["rh.fulltext"] as FullTextExports;

  const text = (value: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: (typeof value === "string" ? value : JSON.stringify(value, null, 1)).slice(0, MAX_TEXT),
      },
    ],
  });
  const card = (paperId: number) =>
    db
      .prepare(
        `SELECT c.summary, c.relevance, c.trust, c.value, c.level, c.matched_question, c.created_at, j.verdict, j.reason
           FROM cards c LEFT JOIN judgments j ON j.card_id = c.id WHERE c.paper_id = ?`,
      )
      .get(paperId) as Record<string, unknown> | undefined;
  const paperSummary = (id: number) => {
    const paper = papers.store.get(id);
    if (!paper) return undefined;
    const paperCard = card(id);
    return {
      paper_id: paper.id,
      title: paper.title,
      year: paper.year,
      venue: paper.venue ?? paper.server,
      ids: paper.ids,
      url: paper.url ?? paper.oaUrl,
      ...(paperCard ? { your_judgment: paperCard.verdict ?? null, card_summary: paperCard.summary } : {}),
    };
  };
  const logged =
    <A>(tool: string, handler: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) =>
    async (args: A) => {
      context.log.info("mcp.call", { tool });
      return handler(args);
    };

  return {
    server() {
      const server = new McpServer({ name: `research-hub-${host.name}`, version: VERSION });
      server.registerTool(
        "search_knowledge",
        {
          description:
            "Full-text search over this research project's knowledge base (evidence notes on papers the user starred, concepts, research questions). Returns note stems, titles and excerpts; read one with read_note.",
          inputSchema: { query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).optional() },
        },
        logged("search_knowledge", ({ query, limit }: { query: string; limit?: number }) =>
          text(
            kb.kbIndex
              .search(query, limit ?? 8)
              .map(({ stem, title, excerpt, path }) => ({ stem, title, path, excerpt })),
          ),
        ),
      );
      server.registerTool(
        "read_note",
        {
          description:
            "Read one knowledge-base note (markdown) by its stem, from search_knowledge (charter, index and log included).",
          inputSchema: { stem: z.string().regex(/^[a-z0-9][a-z0-9-]{0,150}$/) },
        },
        logged("read_note", ({ stem }: { stem: string }) => {
          for (const path of ["sources", "concepts", "questions", ""].map((f) =>
            f ? `${f}/${stem}.md` : `${stem}.md`,
          )) {
            const note = kb.vault.read(path);
            if (note !== undefined) return text(note);
          }
          return text(`No note ${stem}.`);
        }),
      );
      server.registerTool(
        "search_papers",
        {
          description:
            "Semantic search over the papers this project gathered (cards, starred and unstarred). Returns paper ids, titles, years and the user's judgment when there is one; details with get_paper.",
          inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() },
        },
        logged("search_papers", async ({ query, limit }: { query: string; limit?: number }) => {
          const hits = await papers.vectors.similar({ text: query }, { k: limit ?? 8 });
          return text(hits.map((h) => ({ ...paperSummary(h.paperId), distance: Number(h.distance.toFixed(3)) })));
        }),
      );
      server.registerTool(
        "get_paper",
        {
          description:
            "One paper: metadata, abstract, its card (summary, relevance, trust, value, level, matched research question) and the user's judgment and reason; with full_text, the paper's full text when the hub has it.",
          inputSchema: { paper_id: z.number().int().min(1), full_text: z.boolean().optional() },
        },
        logged("get_paper", ({ paper_id, full_text }: { paper_id: number; full_text?: boolean }) => {
          const paper = papers.store.get(paper_id);
          if (!paper) return text(`No paper ${paper_id}.`);
          const stored = full_text ? fulltext.get(paper_id) : undefined;
          return text({
            ...paperSummary(paper_id),
            authors: paper.authors.slice(0, 20),
            abstract: paper.abstract,
            card: card(paper_id) ?? null,
            ...(full_text
              ? {
                  full_text:
                    stored?.status === "ok"
                      ? { source: stored.source, text: withinBudget(stored.sections, 15_000) }
                      : "not available",
                }
              : {}),
          });
        }),
      );
      server.registerTool(
        "recent_cards",
        {
          description:
            "The newest paper cards the project presented, with their summaries, scores and the user's judgments.",
          inputSchema: { limit: z.number().int().min(1).max(30).optional() },
        },
        logged("recent_cards", ({ limit }: { limit?: number }) =>
          text(
            (
              db
                .prepare(
                  `SELECT c.paper_id, p.title, c.summary, c.relevance, c.trust, c.value, c.level, c.matched_question, c.created_at,
                          j.verdict, j.reason FROM cards c JOIN papers p ON p.id = c.paper_id LEFT JOIN judgments j ON j.card_id = c.id
                    ORDER BY c.id DESC LIMIT ?`,
                )
                .all(limit ?? 10) as Record<string, unknown>[]
            ).map((r) => ({ ...r, paper_id: Number(r.paper_id) })),
          ),
        ),
      );
      server.registerTool(
        "get_charter",
        {
          description:
            "The project's research charter in force: research questions, concepts, sub-areas, search queries, what is out of scope.",
          inputSchema: {},
        },
        logged("get_charter", () => {
          const approved = charters.approved();
          return text(approved ? { version: approved.version, ...approved.charter } : "No approved charter yet.");
        }),
      );
      return server;
    },
  };
}
