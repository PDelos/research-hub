// The Library (spec knowledge-vault: Library view): knowledge-base papers with their status, a note parsed into
// properties and body (rendered by the UI), and keyword search over the vault.
import express, { type Router } from "express";
import type { KbNote, KbPaper } from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { int, invalid, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";

/** Split a note into frontmatter properties (`key: <JSON or text>`) and the markdown body. */
export function parseNote(text: string): { properties: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { properties: {}, body: text };
  const properties: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    try {
      properties[kv[1]] = JSON.parse(kv[2]);
    } catch {
      properties[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return { properties, body: text.slice(m[0].length) };
}

export function kbRoutes(hub: Hub): Router {
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
  const p = () => hub.project;

  r.get("/v1/kb/papers", (_req, res) => {
    const project = p();
    const rows = project.db
      .prepare(
        `SELECT r.paper_id, r.card_id, r.status, r.reason AS status_reason, r.created_at, n.stem, c.level, j.reason
         FROM kb_requests r LEFT JOIN kb_notes n ON n.paper_id = r.paper_id LEFT JOIN cards c ON c.id = r.card_id
         LEFT JOIN judgments j ON j.card_id = r.card_id WHERE r.status != 'cancelled' ORDER BY r.created_at DESC`,
      )
      .all() as any[];
    const papers: KbPaper[] = rows.map((row) => {
      const paper = project.papers.store.get(Number(row.paper_id));
      return {
        paperId: Number(row.paper_id),
        cardId: Number(row.card_id),
        stem: row.stem ?? null,
        title: paper?.title ?? "(removed)",
        year: paper?.year,
        venue: paper?.venue ?? paper?.server,
        level: row.level ?? undefined,
        reason: row.reason ?? undefined,
        status: row.status,
        statusReason: row.status_reason ?? undefined,
        addedAt: row.created_at,
      };
    });
    res.json(papers);
  });

  r.get("/v1/kb/notes/:stem", (req, res) => {
    const stem = String(req.params.stem);
    if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(stem)) throw invalid("stem must be lowercase letters, digits and dashes");
    const vault = p().vault;
    for (const folder of ["sources", "concepts", "questions"]) {
      const path = `${folder}/${stem}.md`;
      const text = vault.read(path);
      if (text !== undefined) {
        const note: KbNote = { stem, path, ...parseNote(text) };
        return void res.json(note);
      }
    }
    throw notFound(`No note ${stem}`);
  });

  r.get("/v1/kb/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) throw invalid("q is required");
    const limit = Math.min(20, Math.max(1, int(req.query.limit, "limit", 8)));
    res.json(
      p()
        .kbIndex.search(q, limit)
        .map(({ path, stem, title, excerpt }) => ({ path, stem, title, excerpt })),
    );
  });

  return r;
}
