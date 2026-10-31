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

type ToolResult = { content: { type: "text"; text: string }[] };

const text = (value: unknown): ToolResult => ({
  content: [
    { type: "text", text: (typeof value === "string" ? value : JSON.stringify(value, null, 1)).slice(0, MAX_TEXT) },
  ],
});

/** The read-only queries behind the tools. */
class ProjectReader {
  constructor(
    private readonly deps: {
      db: ReturnType<typeof hostOf>["db"];
      kb: KbExports;
      papers: PapersExports["papers"];
      charters: CharterExports["charters"];
      fulltext: FullTextExports;
    },
  ) {}

  private card(paperId: number) {
    return this.deps.db
      .prepare(
        `SELECT c.summary, c.relevance, c.trust, c.value, c.level, c.matched_question, c.created_at, j.verdict, j.reason
           FROM cards c LEFT JOIN judgments j ON j.card_id = c.id WHERE c.paper_id = ?`,
      )
      .get(paperId) as Record<string, unknown> | undefined;
  }

  private paperSummary(id: number) {
    const paper = this.deps.papers.store.get(id);
    if (!paper) return undefined;
    const paperCard = this.card(id);
    return {
      paper_id: paper.id,
      title: paper.title,
      year: paper.year,
      venue: paper.venue ?? paper.server,
      ids: paper.ids,
      url: paper.url ?? paper.oaUrl,
      ...(paperCard ? { your_judgment: paperCard.verdict ?? null, card_summary: paperCard.summary } : {}),
    };
  }

  searchKnowledge({ query, limit }: { query: string; limit?: number }) {
    return this.deps.kb.kbIndex
      .search(query, limit ?? 8)
      .map(({ stem, title, excerpt, path }) => ({ stem, title, path, excerpt }));
  }

  readNote({ stem }: { stem: string }) {
    for (const folder of ["sources", "concepts", "questions", ""]) {
      const note = this.deps.kb.vault.read(folder ? `${folder}/${stem}.md` : `${stem}.md`);
      if (note !== undefined) return note;
    }
    return `No note ${stem}.`;
  }

  async searchPapers({ query, limit }: { query: string; limit?: number }) {
    const hits = await this.deps.papers.vectors.similar({ text: query }, { k: limit ?? 8 });
    return hits.map((h) => ({ ...this.paperSummary(h.paperId), distance: Number(h.distance.toFixed(3)) }));
  }

  getPaper({ paper_id, full_text }: { paper_id: number; full_text?: boolean }) {
    const paper = this.deps.papers.store.get(paper_id);
    if (!paper) return `No paper ${paper_id}.`;
    return {
      ...this.paperSummary(paper_id),
      authors: paper.authors.slice(0, 20),
      abstract: paper.abstract,
      card: this.card(paper_id) ?? null,
      ...(full_text ? { full_text: this.fullText(paper_id) } : {}),
    };
  }

  private fullText(paperId: number) {
    const stored = this.deps.fulltext.get(paperId);
    if (stored?.status !== "ok") return "not available";
    return { source: stored.source, text: withinBudget(stored.sections, 15_000) };
  }

  recentCards({ limit }: { limit?: number }) {
    const rows = this.deps.db
      .prepare(
        `SELECT c.paper_id, p.title, c.summary, c.relevance, c.trust, c.value, c.level, c.matched_question, c.created_at,
                j.verdict, j.reason FROM cards c JOIN papers p ON p.id = c.paper_id LEFT JOIN judgments j ON j.card_id = c.id
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(limit ?? 10) as Record<string, unknown>[];
    return rows.map((r) => ({ ...r, paper_id: Number(r.paper_id) }));
  }

  charter() {
    const approved = this.deps.charters.approved();
    return approved ? { version: approved.version, ...approved.charter } : "No approved charter yet.";
  }
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  run: (reader: ProjectReader, args: any) => unknown;
}

const TOOLS: Tool[] = [
  {
    name: "search_knowledge",
    description:
      "Full-text search over this research project's knowledge base (evidence notes on papers the user starred, concepts, research questions). Returns note stems, titles and excerpts; read one with read_note.",
    inputSchema: { query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).optional() },
    run: (reader, args) => reader.searchKnowledge(args),
  },
  {
    name: "read_note",
    description:
      "Read one knowledge-base note (markdown) by its stem, from search_knowledge (charter, index and log included).",
    inputSchema: { stem: z.string().regex(/^[a-z0-9][a-z0-9-]{0,150}$/) },
    run: (reader, args) => reader.readNote(args),
  },
  {
    name: "search_papers",
    description:
      "Semantic search over the papers this project gathered (cards, starred and unstarred). Returns paper ids, titles, years and the user's judgment when there is one; details with get_paper.",
    inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() },
    run: (reader, args) => reader.searchPapers(args),
  },
  {
    name: "get_paper",
    description:
      "One paper: metadata, abstract, its card (summary, relevance, trust, value, level, matched research question) and the user's judgment and reason; with full_text, the paper's full text when the hub has it.",
    inputSchema: { paper_id: z.number().int().min(1), full_text: z.boolean().optional() },
    run: (reader, args) => reader.getPaper(args),
  },
  {
    name: "recent_cards",
    description: "The newest paper cards the project presented, with their summaries, scores and the user's judgments.",
    inputSchema: { limit: z.number().int().min(1).max(30).optional() },
    run: (reader, args) => reader.recentCards(args),
  },
  {
    name: "get_charter",
    description:
      "The project's research charter in force: research questions, concepts, sub-areas, search queries, what is out of scope.",
    inputSchema: {},
    run: (reader) => reader.charter(),
  },
];

export function activate(context: PluginContext): McpExports {
  const host = hostOf(context);
  const reader = new ProjectReader({
    db: host.db,
    kb: context.exports["rh.kb"] as KbExports,
    papers: (context.exports["rh.papers"] as PapersExports).papers,
    charters: (context.exports["rh.charter"] as CharterExports).charters,
    fulltext: context.exports["rh.fulltext"] as FullTextExports,
  });
  return {
    server() {
      const server = new McpServer({ name: `research-hub-${host.name}`, version: VERSION });
      for (const tool of TOOLS)
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: tool.inputSchema },
          async (args) => {
            context.log.info("mcp.call", { tool: tool.name });
            return text(await tool.run(reader, args));
          },
        );
      return server;
    },
  };
}
