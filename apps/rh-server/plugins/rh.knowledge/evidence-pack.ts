// The evidence the knowledge review's model reads (design v1-5 D3): the charter, liked and disliked papers with their
// reasons, digest comments, questions asked at the desk, and the open questions in the knowledge base.
import type { Charter } from "../../src/charter.ts";
import type { Db } from "../../src/db.ts";
import type { Vault } from "../../src/kb/vault.ts";

export interface JudgedPaper {
  id: number;
  title: string;
  verdict: string;
  reason: string | null;
  reason_kind: string | null;
  q: string | null;
  level: string;
}

export interface EvidencePack {
  prompt: string;
  judged: JudgedPaper[];
  /** The level most liked papers sit at. */
  level: string;
  comments: string[];
}

const judgedSince = (db: Db, since: string) =>
  db
    .prepare(
      `SELECT p.id, p.title, j.verdict, j.reason, j.reason_kind, c.matched_question q, c.level FROM judgments j
         JOIN papers p ON p.id = j.paper_id JOIN cards c ON c.id = j.card_id
        WHERE j.updated_at >= ? ORDER BY j.updated_at DESC`,
    )
    .all(since) as unknown as JudgedPaper[];

function commentsSince(db: Db, since: string): string[] {
  try {
    const rows = db
      .prepare("SELECT section, text FROM p_rh_digest__comments WHERE created_at >= ? ORDER BY id DESC LIMIT 20")
      .all(since) as { section: string; text: string }[];
    return rows.map((comment) => `${comment.section}: ${comment.text}`);
  } catch {
    return []; // no digest yet
  }
}

const deskQuestionsSince = (db: Db, since: string) =>
  (
    db
      .prepare(
        `SELECT r.text FROM agent_runs r JOIN agent_conversations c ON c.conversation_id = r.conversation_id
          WHERE c.parent_conversation_id IS NULL AND c.owner_task_id IS NULL AND r.text IS NOT NULL AND r.started_at >= ?
          ORDER BY r.run_entry_id DESC LIMIT 20`,
      )
      .all(Date.parse(since)) as { text: string }[]
  ).map((run) => run.text.replace(/\s+/g, " ").slice(0, 300));

/** The "Open questions" section of a note, unless the librarian found none. */
function openQuestionsOf(note: string): string | undefined {
  const section = note
    .split(/^## Open questions\s*$/m)[1]
    ?.split(/^## /m)[0]
    ?.trim();
  if (!section || /^not stated/i.test(section)) return undefined;
  return section.replace(/\s+/g, " ").slice(0, 300);
}

function openQuestions(db: Db, vault: Vault | undefined): string[] {
  const stems = db.prepare("SELECT stem FROM kb_notes ORDER BY created_at DESC LIMIT 30").all() as { stem: string }[];
  return stems
    .flatMap(({ stem }) => {
      const questions = openQuestionsOf(vault?.read(`sources/${stem}.md`) ?? "");
      return questions ? [`${stem}: ${questions}`] : [];
    })
    .slice(0, 10);
}

function paperLine(paper: JudgedPaper): string {
  const question = paper.q ? ` [${paper.q}]` : " [no question]";
  const kind = paper.reason_kind ? ` (${paper.reason_kind})` : "";
  const reason = paper.reason ? `: “${paper.reason.slice(0, 200)}”` : "";
  return `- #${paper.id} ${paper.title}${question}${kind}${reason}`;
}

const section = (title: string, lines: string[]) => `## ${title}\n${lines.join("\n") || "none"}`;

/** The most frequent value (first seen wins a tie), or undefined for an empty list. */
function mostFrequent(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

export function evidencePack(db: Db, vault: Vault | undefined, charter: Charter, since: string): EvidencePack {
  const judged = judgedSince(db, since);
  const liked = judged.filter((paper) => paper.verdict !== "down");
  const disliked = judged.filter((paper) => paper.verdict === "down");
  const comments = commentsSince(db, since);
  const prompt = [
    `## Charter\n${JSON.stringify(charter)}`,
    section("Liked papers (👍/⭐)", liked.slice(0, 20).map(paperLine)),
    section("Disliked papers (👎)", disliked.slice(0, 20).map(paperLine)),
    section(
      "Digest comments",
      comments.map((comment) => `- ${comment}`),
    ),
    section(
      "Questions asked at the desk",
      deskQuestionsSince(db, since).map((question) => `- ${question}`),
    ),
    section(
      "Open questions in the knowledge base",
      openQuestions(db, vault).map((question) => `- ${question}`),
    ),
  ].join("\n\n");
  return { prompt, judged, level: mostFrequent(liked.map((paper) => paper.level)) ?? "not known yet", comments };
}
