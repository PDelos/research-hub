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
 * Validate and normalize a charter draft. Questions are renumbered Q1..Qn (with `keepIds`, existing ids `Q<n>` are
 * kept and new questions get the next free id, so retiring a question does not shift the others); weights default
 * to 1. Every problem is
 * reported with the exact field and bound, e.g. "questions: 9 given, 3 to 7 allowed", so the agent can fix it.
 */
export function validateCharter(input: unknown, options: { keepIds?: boolean } = {}): Charter {
  const problems: string[] = [];
  const body = isRecord(input) ? input : {};
  if (!isRecord(input)) problems.push("charter: must be an object");
  const list = (field: string, [min, max]: readonly [number, number]): unknown[] => {
    let value = body[field];
    if (value === undefined && min === 0) return [];
    // Models sometimes send a list as a JSON-encoded string; accept it when it parses to an array.
    if (typeof value === "string" && value.trim().startsWith("[")) {
      try {
        value = JSON.parse(value);
      } catch {}
    }
    if (!Array.isArray(value)) {
      problems.push(`${field}: must be a list (a JSON array), not ${value === undefined ? "missing" : typeof value}`);
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
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (cleaned.length > max) problems.push(`${field}: ${cleaned.length} characters, at most ${max} allowed`);
    return cleaned;
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

  const rawQuestions = list("questions", LIMITS.questions);
  const kept = new Set<string>();
  if (options.keepIds)
    for (const q of rawQuestions) {
      const id = isRecord(q) && typeof q.id === "string" && /^Q[1-9]\d*$/.test(q.id) ? q.id : undefined;
      if (id && !kept.has(id)) kept.add(id);
    }
  let next = Math.max(0, ...[...kept].map((id) => Number(id.slice(1))));
  const seen = new Set<string>();
  const questions = rawQuestions.map((question, i) => {
    const fields = isRecord(question) ? question : { text: question };
    let id = `Q${i + 1}`;
    if (options.keepIds) {
      const own = typeof fields.id === "string" && kept.has(fields.id) && !seen.has(fields.id) ? fields.id : undefined;
      id = own ?? `Q${++next}`;
      seen.add(id);
    }
    return {
      id,
      text: text(`questions[${i + 1}].text`, fields.text, LIMITS.questionText),
      weight: weight(`questions[${i + 1}].weight`, fields.weight),
    };
  });
  const concepts = strings("concepts", LIMITS.concepts);
  const subAreas = strings("subAreas", LIMITS.subAreas);
  const queries = list("queries", LIMITS.queries).map((query, i) => {
    const fields = isRecord(query) ? query : { text: query };
    return {
      text: text(`queries[${i + 1}].text`, fields.text, LIMITS.queryText),
      weight: weight(`queries[${i + 1}].weight`, fields.weight),
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
    const row = this.db.prepare("SELECT * FROM charters WHERE status = 'draft' ORDER BY id DESC LIMIT 1").get();
    return row ? toRecord(row) : undefined;
  }

  /** The approved charter in force: the highest version. */
  approved(): CharterRecord | undefined {
    const row = this.db.prepare("SELECT * FROM charters WHERE version IS NOT NULL ORDER BY version DESC LIMIT 1").get();
    return row ? toRecord(row) : undefined;
  }

  version(versionNumber: number): CharterRecord | undefined {
    const row = this.db.prepare("SELECT * FROM charters WHERE version = ?").get(versionNumber);
    return row ? toRecord(row) : undefined;
  }

  versions(): { version: number; approvedAt: string; source: string }[] {
    return (
      this.db
        .prepare("SELECT version, approved_at, source FROM charters WHERE version IS NOT NULL ORDER BY version")
        .all() as any[]
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

  /**
   * Approve a charter as the next version directly (an approved knowledge proposal): question ids are kept, an open
   * draft is left as it is.
   */
  approveVersion(charter: Charter, source: "agent" | "user"): CharterRecord {
    const valid = validateCharter(charter, { keepIds: true });
    const next = ((this.db.prepare("SELECT MAX(version) v FROM charters").get() as any).v ?? 0) + 1;
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO charters (status, version, body_json, source, created_at, approved_at) VALUES ('approved', ?, ?, ?, ?, ?)",
      )
      .run(next, JSON.stringify(valid), source, now, now);
    return this.version(next)!;
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
    if (text.includes("�") || text.includes("\u0000")) throw new BriefInvalid("brief must be valid UTF-8 text");
    const chars = [...text].length;
    if (chars > MAX_BRIEF_CHARS)
      throw new BriefInvalid(`brief is ${chars} characters; the limit is ${MAX_BRIEF_CHARS.toLocaleString("en-US")}`);
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, text, "utf8");
    renameSync(temporaryPath, this.path);
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
