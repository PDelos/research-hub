// The harness judge (spec harness: Labels and the calibrated judge; design v1-2 D3): the `would-like` Jev command
// estimates whether the user would like a paper from their research questions and recent judgments. It is trusted
// only while it agrees with the user's own verdicts often enough (re-judging judged papers without themselves among
// the examples); labels are cached per paper and command version.
import type { Db } from "../../src/db.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import { BudgetExceeded } from "../../src/kernel/permissions.ts";

export const COMMAND = "would-like";
export const COMMAND_VERSION = 1;
const EXAMPLES = 12;
const CALIBRATION_CASES = 60;

export interface Calibration {
  cases: number;
  agree: number;
  agreement: number | null;
  kappa: number | null;
  trusted: boolean;
  minAgreement: number;
  minCases: number;
  at: string;
}

export class Judge {
  readonly tables: { labels: string; calibrations: string };

  constructor(
    private readonly rh: RhApi,
    private readonly db: Db,
    private readonly policy: { trust_min_agreement: number; trust_min_cases: number },
  ) {
    this.tables = { labels: rh.db.table("labels"), calibrations: rh.db.table("calibrations") };
  }

  migrations() {
    return [
      {
        version: 1,
        sql: `CREATE TABLE ${this.tables.labels} (paper_id INTEGER NOT NULL, command_version INTEGER NOT NULL,
                probability REAL NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (paper_id, command_version));
              CREATE TABLE ${this.tables.calibrations} (id INTEGER PRIMARY KEY, body_json TEXT NOT NULL, created_at TEXT NOT NULL);`,
      },
    ];
  }

  /** Cached probability, if any. */
  cached(paperId: number): number | undefined {
    const row = this.db
      .prepare(`SELECT probability FROM ${this.tables.labels} WHERE paper_id = ? AND command_version = ?`)
      .get(paperId, COMMAND_VERSION) as { probability: number } | undefined;
    return row?.probability;
  }

  private examples(exclude: number) {
    return (
      this.db
        .prepare(
          "SELECT p.title, j.verdict, j.reason FROM judgments j JOIN papers p ON p.id = j.paper_id WHERE j.paper_id != ? ORDER BY j.updated_at DESC LIMIT ?",
        )
        .all(exclude, EXAMPLES) as { title: string; verdict: string; reason: string | null }[]
    ).map((e) => ({ title: e.title, verdict: e.verdict, ...(e.reason ? { reason: e.reason.slice(0, 200) } : {}) }));
  }

  private questions(): string[] {
    const row = this.db
      .prepare("SELECT body_json FROM charters WHERE status = 'approved' ORDER BY version DESC LIMIT 1")
      .get() as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json).questions as { text: string }[]).map((q) => q.text) : [];
  }

  /** Judge one paper (cached); the paper itself is never among the examples. */
  async label(paperId: number): Promise<number> {
    const hit = this.cached(paperId);
    if (hit !== undefined) return hit;
    const paper = this.db.prepare("SELECT title, abstract FROM papers WHERE id = ?").get(paperId) as
      | { title: string; abstract: string | null }
      | undefined;
    if (!paper) throw new Error(`no paper ${paperId}`);
    const { answers } = await this.rh.decisions.decide(COMMAND, {
      questions: this.questions(),
      examples: this.examples(paperId),
      title: paper.title,
      abstract: (paper.abstract ?? "(no abstract)").slice(0, 4000),
    });
    const like = answers.like as { type: string; noul?: number } | undefined;
    const probability = typeof like?.noul === "number" ? like.noul : 0.5;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.tables.labels} (paper_id, command_version, probability, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(paperId, COMMAND_VERSION, probability, new Date().toISOString());
    return probability;
  }

  /** Re-judge the most recent judged papers and measure agreement (probability ≥ 0.5 ⇔ 👍/⭐). */
  async calibrate(): Promise<Calibration> {
    const judged = this.db
      .prepare("SELECT paper_id, verdict FROM judgments ORDER BY updated_at DESC LIMIT ?")
      .all(CALIBRATION_CASES) as { paper_id: number; verdict: string }[];
    const pairs: { judge: boolean; user: boolean }[] = [];
    for (const j of judged) {
      try {
        const probability = await this.label(Number(j.paper_id));
        pairs.push({ judge: probability >= 0.5, user: j.verdict !== "down" });
      } catch (error) {
        if (error instanceof BudgetExceeded) break;
        throw error;
      }
    }
    const cases = pairs.length;
    const agree = pairs.filter((x) => x.judge === x.user).length;
    const agreement = cases ? agree / cases : null;
    let kappa: number | null = null;
    if (cases) {
      const pj = pairs.filter((x) => x.judge).length / cases;
      const pu = pairs.filter((x) => x.user).length / cases;
      const pe = pj * pu + (1 - pj) * (1 - pu);
      kappa = pe < 1 ? (agreement! - pe) / (1 - pe) : null;
    }
    const calibration: Calibration = {
      cases,
      agree,
      agreement,
      kappa,
      trusted: cases >= this.policy.trust_min_cases && (agreement ?? 0) >= this.policy.trust_min_agreement,
      minAgreement: this.policy.trust_min_agreement,
      minCases: this.policy.trust_min_cases,
      at: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO ${this.tables.calibrations} (body_json, created_at) VALUES (?, ?)`)
      .run(JSON.stringify(calibration), calibration.at);
    return calibration;
  }

  latestCalibration(): Calibration | undefined {
    const row = this.db.prepare(`SELECT body_json FROM ${this.tables.calibrations} ORDER BY id DESC LIMIT 1`).get() as
      | { body_json: string }
      | undefined;
    return row ? (JSON.parse(row.body_json) as Calibration) : undefined;
  }

  /** Label unjudged papers of recent sweeps, newest sweep first, until the daily budget stops it. */
  async labelRecent(
    options: { sinceDays?: number; now?: number } = {},
  ): Promise<{ labelled: number; stoppedByBudget: boolean }> {
    const since = new Date((options.now ?? Date.now()) - (options.sinceDays ?? 30) * 86_400_000).toISOString();
    const papers = this.db
      .prepare(
        `SELECT sp.paper_id FROM sweep_papers sp JOIN sweeps s ON s.id = sp.sweep_id
          WHERE s.started_at >= ? AND sp.relevance IS NOT NULL AND sp.worth IS NOT NULL
            AND sp.paper_id NOT IN (SELECT paper_id FROM judgments)
            AND sp.paper_id NOT IN (SELECT paper_id FROM ${this.tables.labels} WHERE command_version = ?)
          GROUP BY sp.paper_id ORDER BY MAX(s.id) DESC, MAX(sp.relevance) DESC`,
      )
      .all(since, COMMAND_VERSION) as { paper_id: number }[];
    let labelled = 0;
    for (const p of papers) {
      try {
        await this.label(Number(p.paper_id));
        labelled++;
      } catch (error) {
        if (error instanceof BudgetExceeded) return { labelled, stoppedByBudget: true };
        throw error;
      }
    }
    return { labelled, stoppedByBudget: false };
  }

  /** Judge labels for replays: only while the judge is trusted. */
  labelsIfTrusted(): Map<number, number> | undefined {
    if (!this.latestCalibration()?.trusted) return undefined;
    const rows = this.db
      .prepare(`SELECT paper_id, probability FROM ${this.tables.labels} WHERE command_version = ?`)
      .all(COMMAND_VERSION) as { paper_id: number; probability: number }[];
    return new Map(rows.map((r) => [Number(r.paper_id), r.probability]));
  }
}
