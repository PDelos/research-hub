// Reason classification (spec paper-feedback: Reason classification; design D4): one Jev `reason-parse` call per
// non-empty reason. A reason that states a general rule (≥ 0.7) is queued as a rule candidate for the weekly review;
// 0.4–0.7 is stored as unclassified; no LLM is called. If Jev fails, the judgment stays `pending` and is retried.
import {
  loadCommand,
  runCommand,
  type ChoiceAnswer,
  type Decide,
  type JevCommand,
  type JevLedger,
  type NoulAnswer,
} from "@rh/jev";
import { nowIso, type Db } from "../db.ts";
import type { Logger } from "../logger.ts";

export class ReasonParser {
  readonly command: JevCommand;

  constructor(private readonly deps: { db: Db; jevDir: string; decide: Decide; ledger: JevLedger; log: Logger }) {
    this.command = loadCommand("reason-parse", deps.jevDir);
  }

  private running?: Promise<number>;
  private again = false;

  /**
   * Classify every judgment whose reason is still pending; returns how many were classified. Calls never overlap: a
   * call made while one runs is folded into one more pass afterwards, so no reason is sent to Jev twice.
   */
  parsePending(): Promise<number> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let total = 0;
      do {
        this.again = false;
        total += await this.pass();
      } while (this.again);
      return total;
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private async pass(): Promise<number> {
    const rows = this.deps.db
      .prepare(
        "SELECT j.card_id, j.verdict, j.reason, p.title FROM judgments j JOIN papers p ON p.id = j.paper_id WHERE j.rule_status = 'pending' AND j.reason IS NOT NULL ORDER BY j.updated_at",
      )
      .all() as { card_id: number; verdict: string; reason: string; title: string }[];
    let done = 0;
    for (const row of rows) {
      try {
        await this.parse(Number(row.card_id), row.verdict, row.reason, row.title);
        done++;
      } catch (error) {
        this.deps.log.warn("feedback.reason_parse_failed", {
          cardId: row.card_id,
          error: error instanceof Error ? error.message : String(error),
        });
        break; // Jev is down: leave the rest pending for the next attempt
      }
    }
    return done;
  }

  private async parse(cardId: number, verdict: string, reason: string, title: string): Promise<void> {
    const cmd = this.command;
    let result;
    try {
      ({ result } = await runCommand(cmd, { verdict, reason, title }, this.deps.decide));
    } catch (error) {
      this.deps.ledger.fail(error, { command: cmd.name, version: cmd.version, questions: 2, extra: { cardId } });
      throw error;
    }
    this.deps.ledger.record(result, { command: cmd.name, version: cmd.version, extra: { cardId } });
    const kind = (result.answers.reason_kind as ChoiceAnswer).choice;
    const probability = (result.answers.generalizable as NoulAnswer).noul;
    const policy = cmd.policy as { candidate_min: number; unclassified_min: number };
    const status = ruleStatus(probability, policy);
    const db = this.deps.db;
    // Only apply if the reason was not changed meanwhile.
    const changed = db
      .prepare(
        "UPDATE judgments SET reason_kind = ?, rule_probability = ?, rule_status = ? WHERE card_id = ? AND reason = ? AND rule_status = 'pending'",
      )
      .run(kind, probability, status, cardId, reason).changes;
    if (Number(changed) && status === "candidate")
      db.prepare(
        "INSERT INTO rule_candidates (card_id, reason, reason_kind, probability, status, created_at) VALUES (?, ?, ?, ?, 'open', ?) ON CONFLICT (card_id) DO UPDATE SET reason = excluded.reason, reason_kind = excluded.reason_kind, probability = excluded.probability",
      ).run(cardId, reason, kind, probability, nowIso());
    this.deps.log.info("feedback.reason_parsed", { cardId, kind, generalizable: probability, status });
  }

  candidates(): {
    cardId: number;
    reason: string;
    reasonKind?: string;
    probability: number;
    status: string;
    createdAt: string;
  }[] {
    return (this.deps.db.prepare("SELECT * FROM rule_candidates ORDER BY created_at").all() as any[]).map((r) => ({
      cardId: Number(r.card_id),
      reason: r.reason,
      reasonKind: r.reason_kind ?? undefined,
      probability: Number(r.probability),
      status: r.status,
      createdAt: r.created_at,
    }));
  }
}

/** A generalizable reason becomes a rule candidate, an unclassified one, or nothing, by its probability. */
function ruleStatus(probability: number, policy: { candidate_min: number; unclassified_min: number }) {
  if (probability >= policy.candidate_min) return "candidate";
  if (probability >= policy.unclassified_min) return "unclassified";
  return "none";
}
