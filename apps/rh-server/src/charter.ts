// The project's direction: the brief, the charter (rules, drafts, approved versions), scoping questions, pause, and
// the derived project status. Plain storage and validation; the charter writer agent lives in charter-writer.ts.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso, Settings, type Db } from "./db.ts";

// ---------------------------------------------------------------- charter rules

export interface CharterQuestion {
  id: string;
  text: string;
  weight: number;
}
export interface CharterQuery {
  text: string;
  weight: number;
}
export interface Charter {
  questions: CharterQuestion[];
  concepts: string[];
  subAreas: string[];
  queries: CharterQuery[];
  outOfScope: string[];
}

export const LIMITS = {
  questions: [3, 7],
  concepts: [1, 30],
  subAreas: [1, 15],
  queries: [5, 20],
  outOfScope: [0, 20],
  questionText: 300,
  queryText: 120,
  itemText: 120,
  weight: [0.1, 2],
} as const;

export class CharterInvalid extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "CharterInvalid";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Validate and normalize a charter draft. Questions are renumbered Q1..Qn; weights default to 1. Every problem is
 * reported with the exact field and bound, e.g. "questions: 9 given, 3 to 7 allowed", so the agent can fix it.
 */
export function validateCharter(input: unknown): Charter {
  const problems: string[] = [];
  const body = isRecord(input) ? input : {};
  if (!isRecord(input)) problems.push("charter: must be an object");
  const list = (field: string, [min, max]: readonly [number, number]): unknown[] => {
    const value = body[field];
    if (value === undefined && min === 0) return [];
    if (!Array.isArray(value)) {
      problems.push(`${field}: must be a list`);
      return [];
    }
    if (value.length < min || value.length > max)
      problems.push(`${field}: ${value.length} given, ${min} to ${max} allowed`);
    return value;
  };
  const text = (field: string, value: unknown, max: number): string => {
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`${field}: must be nonblank text`);
      return "";
    }
    const t = value.trim().replace(/\s+/g, " ");
    if (t.length > max) problems.push(`${field}: ${t.length} characters, at most ${max} allowed`);
    return t;
  };
  const weight = (field: string, value: unknown): number => {
    if (value === undefined) return 1;
    const [min, max] = LIMITS.weight;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${field}: ${JSON.stringify(value)} given, a number from ${min} to ${max} allowed`);
      return 1;
    }
    return Math.round(value * 100) / 100;
  };
  const strings = (field: string, bounds: readonly [number, number]) =>
    list(field, bounds).map((v, i) => text(`${field}[${i + 1}]`, v, LIMITS.itemText));

  const questions = list("questions", LIMITS.questions).map((q, i) => {
    const r = isRecord(q) ? q : { text: q };
    return {
      id: `Q${i + 1}`,
      text: text(`questions[${i + 1}].text`, r.text, LIMITS.questionText),
      weight: weight(`questions[${i + 1}].weight`, r.weight),
    };
  });
  const concepts = strings("concepts", LIMITS.concepts);
  const subAreas = strings("subAreas", LIMITS.subAreas);
  const queries = list("queries", LIMITS.queries).map((q, i) => {
    const r = isRecord(q) ? q : { text: q };
    return {
      text: text(`queries[${i + 1}].text`, r.text, LIMITS.queryText),
      weight: weight(`queries[${i + 1}].weight`, r.weight),
    };
  });
  const outOfScope = strings("outOfScope", LIMITS.outOfScope);
  if (problems.length) throw new CharterInvalid(problems);
  return { questions, concepts, subAreas, queries, outOfScope };
}

// ---------------------------------------------------------------- charters and versions

export interface CharterRecord {
  id: number;
  status: "draft" | "approved" | "superseded";
  version: number | null;
  charter: Charter;
  source: "agent" | "user";
  createdAt: string;
  approvedAt: string | null;
}

const toRecord = (r: any): CharterRecord => ({
  id: r.id,
  status: r.status,
  version: r.version ?? null,
  charter: JSON.parse(r.body_json),
  source: r.source,
  createdAt: r.created_at,
  approvedAt: r.approved_at ?? null,
});

export class Charters {
  constructor(private readonly db: Db) {}

  /** The open draft, if any. */
  draft(): CharterRecord | undefined {
    const r = this.db.prepare("SELECT * FROM charters WHERE status = 'draft' ORDER BY id DESC LIMIT 1").get();
    return r ? toRecord(r) : undefined;
  }

  /** The approved charter in force: the highest version. */
  approved(): CharterRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM charters WHERE version IS NOT NULL ORDER BY version DESC LIMIT 1")
      .get();
    return r ? toRecord(r) : undefined;
  }

  version(n: number): CharterRecord | undefined {
    const r = this.db.prepare("SELECT * FROM charters WHERE version = ?").get(n);
    return r ? toRecord(r) : undefined;
  }

  versions(): { version: number; approvedAt: string; source: string }[] {
    return (
      this.db.prepare("SELECT version, approved_at, source FROM charters WHERE version IS NOT NULL ORDER BY version").all() as any[]
    ).map((r) => ({ version: r.version, approvedAt: r.approved_at, source: r.source }));
  }

  /** Store a valid draft; it replaces any open draft. */
  saveDraft(charter: Charter, source: "agent" | "user"): CharterRecord {
    const valid = validateCharter(charter);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE charters SET status = 'superseded' WHERE status = 'draft'").run();
      const id = Number(
        this.db
          .prepare("INSERT INTO charters (status, body_json, source, created_at) VALUES ('draft', ?, ?, ?)")
          .run(JSON.stringify(valid), source, nowIso()).lastInsertRowid,
      );
      this.db.exec("COMMIT");
      return toRecord(this.db.prepare("SELECT * FROM charters WHERE id = ?").get(id));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Approve the open draft as the next version. Returns undefined when there is no draft. */
  approve(): CharterRecord | undefined {
    const draft = this.draft();
    if (!draft) return undefined;
    const next = ((this.db.prepare("SELECT MAX(version) v FROM charters").get() as any).v ?? 0) + 1;
    this.db
      .prepare("UPDATE charters SET status = 'approved', version = ?, approved_at = ? WHERE id = ?")
      .run(next, nowIso(), draft.id);
    return this.version(next);
  }
}

// ---------------------------------------------------------------- scoping questions

export const MAX_SCOPING_QUESTIONS = 5;

export interface ScopingQuestion {
  id: number;
  round: number;
  text: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export class ScopingQuestions {
  constructor(private readonly db: Db) {}

  all(): ScopingQuestion[] {
    return (this.db.prepare("SELECT * FROM scoping_questions ORDER BY id").all() as any[]).map((r) => ({
      id: r.id,
      round: r.round,
      text: r.text,
      answer: r.answer,
      askedAt: r.asked_at,
      answeredAt: r.answered_at,
    }));
  }

  open(): ScopingQuestion[] {
    return this.all().filter((q) => q.answer === null);
  }

  remaining(): number {
    return MAX_SCOPING_QUESTIONS - this.all().length;
  }

  /** Add questions for a round; throws when the 5-question total would be exceeded. */
  ask(round: number, texts: string[]): ScopingQuestion[] {
    const left = this.remaining();
    if (texts.length > left)
      throw new Error(
        `only ${left} more scoping question${left === 1 ? "" : "s"} allowed (${MAX_SCOPING_QUESTIONS} in total)`,
      );
    const insert = this.db.prepare("INSERT INTO scoping_questions (round, text, asked_at) VALUES (?, ?, ?)");
    for (const t of texts) insert.run(round, t, nowIso());
    return this.all().slice(-texts.length);
  }

  answer(answers: { id: number; answer: string }[]): ScopingQuestion[] {
    const update = this.db.prepare(
      "UPDATE scoping_questions SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL",
    );
    for (const a of answers) update.run(a.answer, nowIso(), a.id);
    return this.all().filter((q) => answers.some((a) => a.id === q.id));
  }
}

// ---------------------------------------------------------------- brief

export const MAX_BRIEF_CHARS = 50_000;

export class BriefInvalid extends Error {}

export class Brief {
  constructor(private readonly dir: string) {}

  get path(): string {
    return join(this.dir, "brief.md");
  }

  read(): string | undefined {
    return existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined;
  }

  /** Validate (UTF-8 text, nonblank, ≤ 50,000 characters) and store atomically; nothing is written on failure. */
  write(text: unknown): string {
    if (typeof text !== "string" || !text.trim()) throw new BriefInvalid("brief must be nonblank markdown text");
    if (text.includes("�") || text.includes("\u0000"))
      throw new BriefInvalid("brief must be valid UTF-8 text");
    const chars = [...text].length;
    if (chars > MAX_BRIEF_CHARS)
      throw new BriefInvalid(`brief is ${chars} characters; the limit is ${MAX_BRIEF_CHARS.toLocaleString("en-US")}`);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, this.path);
    return text;
  }
}

// ---------------------------------------------------------------- status

export type ProjectStatus = "needs-brief" | "charter-review" | "active" | "paused";

export class ProjectState {
  constructor(
    private readonly settings: Settings,
    private readonly brief: Brief,
    private readonly charters: Charters,
  ) {}

  /** Derived from the data, except `paused`, which is stored. */
  status(): ProjectStatus {
    if (this.paused()) return "paused";
    return this.underlying();
  }

  /** The status the project returns to when resumed. */
  underlying(): Exclude<ProjectStatus, "paused"> {
    if (this.brief.read() === undefined) return "needs-brief";
    return this.charters.approved() ? "active" : "charter-review";
  }

  paused(): { since: string } | undefined {
    return this.settings.get<{ since: string } | null>("paused", null) ?? undefined;
  }

  pause(): void {
    if (!this.paused()) this.settings.set("paused", { since: nowIso() });
  }

  resume(now = Date.now()): void {
    if (!this.paused()) return;
    this.settings.set("paused", null);
    this.settings.set("resumed_at", new Date(now).toISOString());
  }

  resumedAt(): number | undefined {
    const at = this.settings.get<string | null>("resumed_at", null);
    return at ? Date.parse(at) : undefined;
  }
}
