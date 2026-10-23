// project.sqlite: the app's own database for one project (pi-durable keeps agent.sqlite separately).
// Node's built-in SQLite with the sqlite-vec extension; FTS5 and vectors are proven at open time.
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: settings, idempotency, telemetry (adapted from disler/pi-durable-news-agent's schema).
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE requests (
    key TEXT PRIMARY KEY, route TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE agent_conversations (
    conversation_id INTEGER PRIMARY KEY, agent TEXT, owner_conversation_id INTEGER, owner_task_id INTEGER,
    parent_conversation_id INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE agent_runs (
    run_entry_id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, submission_id INTEGER,
    text TEXT, status TEXT NOT NULL DEFAULT 'running', started_at INTEGER NOT NULL, ended_at INTEGER,
    answer_entry_id INTEGER
  );
  CREATE INDEX agent_runs_conversation ON agent_runs (conversation_id, started_at);
  CREATE TABLE generations (
    entry_id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, run_entry_id INTEGER, task_id INTEGER,
    provider TEXT, model TEXT, stop_reason TEXT, error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, context_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER, text TEXT, tool_calls INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX generations_run ON generations (run_entry_id);
  CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY, generation_entry_id INTEGER NOT NULL, call_id TEXT NOT NULL,
    conversation_id INTEGER NOT NULL, run_entry_id INTEGER, task_id INTEGER UNIQUE, tool_name TEXT NOT NULL,
    args_json TEXT, status TEXT NOT NULL DEFAULT 'pending', is_error INTEGER NOT NULL DEFAULT 0, result_text TEXT,
    result_entry_id INTEGER, duration_ms INTEGER, started_at INTEGER, ended_at INTEGER,
    UNIQUE (generation_entry_id, call_id)
  );
  CREATE INDEX tool_calls_run ON tool_calls (run_entry_id);
  CREATE TABLE tasks (
    task_id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, owner_task_id INTEGER,
    background INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, outcome TEXT, error TEXT, started_at INTEGER,
    ended_at INTEGER
  );
  CREATE TABLE jev_calls (
    id INTEGER PRIMARY KEY, command TEXT, version INTEGER, provider TEXT, model TEXT,
    questions INTEGER NOT NULL DEFAULT 0, answers_json TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cost_usd REAL, cost_source TEXT NOT NULL, elapsed_ms INTEGER, attempts INTEGER, error TEXT, created_at TEXT NOT NULL
  );
  `,
  // 2 (v0-1-project-setup): charters and their versions, scoping questions, scheduled runs (one per kind and slot).
  `
  CREATE TABLE charters (
    id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
    version INTEGER UNIQUE, body_json TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('agent', 'user')),
    created_at TEXT NOT NULL, approved_at TEXT
  );
  CREATE TABLE scoping_questions (
    id INTEGER PRIMARY KEY, round INTEGER NOT NULL, text TEXT NOT NULL, answer TEXT,
    asked_at TEXT NOT NULL, answered_at TEXT
  );
  CREATE TABLE scheduled_runs (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('sweep', 'review')), slot TEXT NOT NULL, slot_at INTEGER,
    trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'done', 'failed', 'skipped')),
    reason TEXT, created_at TEXT NOT NULL, UNIQUE (kind, slot)
  );
  `,
  // 3 (v0-2-paper-sources): paper records, identifiers, sources, metadata cache, citation links, facet labels,
  // representations and embedding calls. The sqlite-vec tables depend on the configured dimension and are created
  // at startup by ensureVectorTables().
  `
  CREATE TABLE papers (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, title_norm TEXT NOT NULL, abstract TEXT, authors_json TEXT NOT NULL DEFAULT '[]',
    year INTEGER, published_at TEXT, venue TEXT, server TEXT, oa_url TEXT, url TEXT,
    cited_by_count INTEGER, references_count INTEGER, retracted INTEGER NOT NULL DEFAULT 0,
    enrichment TEXT NOT NULL DEFAULT 'pending' CHECK (enrichment IN ('pending', 'done', 'missing')),
    enrichment_attempts INTEGER NOT NULL DEFAULT 0, possible_duplicate_of INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX papers_title_norm ON papers (title_norm);
  CREATE TABLE paper_ids (
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('doi', 'arxiv', 'pmid', 'pmcid', 'openalex', 's2')),
    value TEXT NOT NULL, UNIQUE (kind, value)
  );
  CREATE INDEX paper_ids_paper ON paper_ids (paper_id);
  CREATE TABLE paper_sources (
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE, source TEXT NOT NULL,
    external_id TEXT, fetched_at TEXT NOT NULL, UNIQUE (paper_id, source)
  );
  CREATE TABLE metadata_cache (key TEXT PRIMARY KEY, body_json TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE citation_links (
    citing_paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
    cited_kind TEXT NOT NULL, cited_value TEXT NOT NULL, cited_paper_id INTEGER,
    UNIQUE (citing_paper_id, cited_kind, cited_value)
  );
  CREATE INDEX citation_links_cited ON citation_links (cited_kind, cited_value);
  CREATE TABLE facet_labels (
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE, sentence_index INTEGER NOT NULL,
    sentence TEXT NOT NULL, facet TEXT NOT NULL CHECK (facet IN ('background', 'method', 'result', 'other')),
    confidence REAL NOT NULL, command_version INTEGER NOT NULL, UNIQUE (paper_id, sentence_index)
  );
  CREATE TABLE representations (
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('whole', 'background', 'method', 'result')),
    model TEXT NOT NULL, dims INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (paper_id, kind)
  );
  CREATE TABLE embedding_calls (
    id INTEGER PRIMARY KEY, model TEXT NOT NULL, inputs INTEGER NOT NULL, tokens INTEGER,
    cost_usd REAL, cost_source TEXT NOT NULL, elapsed_ms INTEGER, error TEXT, created_at TEXT NOT NULL
  );
  `,
  // 4 (v0-3-daily-sweep): sweeps, per-paper sweep state, stored Jev decisions, cards, arXiv categories, cost tags.
  `
  CREATE TABLE sweeps (
    id INTEGER PRIMARY KEY, scheduled_run_id INTEGER, trigger TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'no_new_papers', 'failed')),
    phase TEXT NOT NULL, orientation INTEGER NOT NULL DEFAULT 0, queries_json TEXT NOT NULL DEFAULT '[]',
    window_since TEXT, counts_json TEXT NOT NULL DEFAULT '{}', phases_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, error TEXT,
    conversation_id INTEGER, submission_id INTEGER, completion_json TEXT, cost_json TEXT,
    started_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE TABLE sweep_papers (
    sweep_id INTEGER NOT NULL REFERENCES sweeps (id) ON DELETE CASCADE,
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('new', 'rejected', 'gated', 'ranked_out', 'candidate', 'presented', 'skipped', 'blocked')),
    reason TEXT, borderline INTEGER NOT NULL DEFAULT 0, relevance REAL, matched_question TEXT, kind TEXT,
    worth REAL, novelty REAL, level TEXT, prereq_heavy REAL, importance REAL, rank_score REAL, rank INTEGER,
    UNIQUE (sweep_id, paper_id)
  );
  CREATE INDEX sweep_papers_paper ON sweep_papers (paper_id, status);
  CREATE TABLE paper_decisions (
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE, command TEXT NOT NULL, version INTEGER NOT NULL,
    answers_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (paper_id, command, version)
  );
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY, paper_id INTEGER NOT NULL UNIQUE REFERENCES papers (id) ON DELETE CASCADE,
    sweep_id INTEGER NOT NULL REFERENCES sweeps (id), rank INTEGER, summary TEXT NOT NULL,
    relevance INTEGER NOT NULL, relevance_reason TEXT NOT NULL, trust INTEGER NOT NULL, trust_reason TEXT NOT NULL,
    value INTEGER NOT NULL, value_reason TEXT NOT NULL, level TEXT NOT NULL, matched_question TEXT,
    borderline INTEGER NOT NULL DEFAULT 0, details_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX cards_sweep ON cards (sweep_id);
  ALTER TABLE papers ADD COLUMN categories_json TEXT;
  ALTER TABLE jev_calls ADD COLUMN tag TEXT;
  ALTER TABLE embedding_calls ADD COLUMN tag TEXT;
  `,
  // 5 (v0-4-feedback): judgments, replayed weights and their effects, rule candidates, knowledge-base requests.
  `
  CREATE TABLE judgments (
    card_id INTEGER NOT NULL UNIQUE REFERENCES cards (id) ON DELETE CASCADE,
    paper_id INTEGER NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN ('up', 'down', 'star')), reason TEXT,
    reason_kind TEXT, rule_probability REAL,
    rule_status TEXT NOT NULL DEFAULT 'none' CHECK (rule_status IN ('none', 'candidate', 'unclassified', 'pending')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE weight_effects (
    card_id INTEGER NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'query', 'source')), key TEXT NOT NULL,
    before REAL NOT NULL, after REAL NOT NULL
  );
  CREATE INDEX weight_effects_card ON weight_effects (card_id);
  CREATE TABLE weights (
    kind TEXT NOT NULL CHECK (kind IN ('question', 'query', 'source')), key TEXT NOT NULL,
    base REAL NOT NULL, value REAL NOT NULL, UNIQUE (kind, key)
  );
  CREATE TABLE rule_candidates (
    card_id INTEGER NOT NULL UNIQUE REFERENCES cards (id) ON DELETE CASCADE, reason TEXT NOT NULL,
    reason_kind TEXT, probability REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
  );
  CREATE TABLE kb_requests (
    paper_id INTEGER NOT NULL UNIQUE REFERENCES papers (id) ON DELETE CASCADE, card_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled', 'done')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  ALTER TABLE sweep_papers ADD COLUMN queries_json TEXT;
  ALTER TABLE jev_calls ADD COLUMN extra_json TEXT;
  `,
  // 6 (v0-5-knowledge-vault): evidence notes per paper, the vault search index (rebuildable from the files), and
  // ingest attempts on knowledge-base requests (status 'failed' added).
  `
  CREATE TABLE kb_notes (
    paper_id INTEGER NOT NULL UNIQUE REFERENCES papers (id) ON DELETE CASCADE, stem TEXT NOT NULL UNIQUE,
    summary TEXT, created_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE kb_fts USING fts5(path UNINDEXED, title, body, tokenize = 'porter unicode61');
  CREATE TABLE kb_files (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE kb_requests_v6 (
    paper_id INTEGER NOT NULL UNIQUE REFERENCES papers (id) ON DELETE CASCADE, card_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, reason TEXT, conversation_id INTEGER, submission_id INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO kb_requests_v6 (paper_id, card_id, status, created_at, updated_at)
    SELECT paper_id, card_id, status, created_at, updated_at FROM kb_requests;
  DROP TABLE kb_requests;
  ALTER TABLE kb_requests_v6 RENAME TO kb_requests;
  `,
];

export const VECTOR_KINDS = ["whole", "background", "method", "result"] as const;
export type VectorKind = (typeof VECTOR_KINDS)[number];

/**
 * Create the sqlite-vec tables (vec_whole, vec_background, vec_method, vec_result) for `dims`, rowid = paper id.
 * Returns true when they were (re)created, which happens on first start and when the dimension changes.
 */
export function ensureVectorTables(db: Db, dims: number): boolean {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_whole'").get() as { sql: string } | undefined;
  if (current && current.sql.includes(`float[${dims}]`)) return false;
  for (const kind of VECTOR_KINDS) {
    db.exec(`DROP TABLE IF EXISTS vec_${kind}`);
    db.exec(`CREATE VIRTUAL TABLE vec_${kind} USING vec0(embedding float[${dims}] distance_metric=cosine)`);
  }
  return true;
}

export interface SelfCheck {
  fts5: boolean;
  vec: string | null;
}

export function openProjectDb(path: string): { db: Db; check: SelfCheck } {
  const db = new DatabaseSync(path, { allowExtension: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  sqliteVec.load(db);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { db, check: selfCheck(db) };
}

/** Prove the features later layers depend on: FTS5 keyword search and sqlite-vec nearest neighbours. */
export function selfCheck(db: Db): SelfCheck {
  let fts5 = false;
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(body)");
    db.prepare("INSERT INTO temp.fts_probe VALUES (?)").run("contact map prediction");
    fts5 = (db.prepare("SELECT count(*) n FROM temp.fts_probe WHERE fts_probe MATCH 'contact'").get() as any).n === 1;
    db.exec("DROP TABLE temp.fts_probe");
  } catch {
    fts5 = false;
  }
  let vec: string | null = null;
  try {
    db.exec("CREATE VIRTUAL TABLE temp.vec_probe USING vec0(e float[2])");
    db.prepare("INSERT INTO temp.vec_probe(rowid, e) VALUES (1, ?)").run(new Float32Array([1, 0]));
    const hit = db
      .prepare("SELECT rowid FROM temp.vec_probe WHERE e MATCH ? ORDER BY distance LIMIT 1")
      .get(new Float32Array([0.9, 0.1])) as { rowid: number } | undefined;
    db.exec("DROP TABLE temp.vec_probe");
    if (hit?.rowid === 1) vec = (db.prepare("SELECT vec_version() v").get() as { v: string }).v;
  } catch {
    vec = null;
  }
  return { fts5, vec };
}

export const nowIso = () => new Date().toISOString();

/** Bind named parameters: undefined → null, booleans → 0/1, objects → JSON. */
export function bind(params: Record<string, unknown>): Record<string, string | number | bigint | null> {
  const out: Record<string, string | number | bigint | null> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] =
      v === undefined || v === null
        ? null
        : typeof v === "boolean"
          ? v ? 1 : 0
          : typeof v === "object"
            ? JSON.stringify(v)
            : (v as string | number | bigint);
  }
  return out;
}

export class Settings {
  constructor(private readonly db: Db) {}
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), nowIso());
  }
}
