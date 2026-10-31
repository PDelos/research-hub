// The sweep's rows as records: a sweep with its phases, queries and counts, and each paper it looked at.
import type { Level } from "./policy.ts";
import type { Phase, SweepRecord, SweepStatus } from "./sweep.ts";

export interface SweepPaper {
  sweepId: number;
  paperId: number;
  status: string;
  reason?: string;
  borderline: boolean;
  relevance?: number;
  matchedQuestion?: string;
  kind?: string;
  worth?: number;
  novelty?: number;
  level?: Level;
  prereqHeavy?: number;
  importance?: number;
  rankScore?: number;
  rank?: number;
}

export interface SweepPaperRow {
  sweep_id: number;
  paper_id: number;
  status: string;
  reason: string | null;
  borderline: number;
  relevance: number | null;
  matched_question: string | null;
  kind: string | null;
  worth: number | null;
  novelty: number | null;
  level: Level | null;
  prereq_heavy: number | null;
  importance: number | null;
  rank_score: number | null;
  rank: number | null;
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export function toSweepPaper(sweepPaperRow: SweepPaperRow): SweepPaper {
  return {
    sweepId: Number(sweepPaperRow.sweep_id),
    paperId: Number(sweepPaperRow.paper_id),
    status: sweepPaperRow.status,
    reason: opt(sweepPaperRow.reason),
    borderline: !!sweepPaperRow.borderline,
    relevance: opt(sweepPaperRow.relevance),
    matchedQuestion: opt(sweepPaperRow.matched_question),
    kind: opt(sweepPaperRow.kind),
    worth: opt(sweepPaperRow.worth),
    novelty: opt(sweepPaperRow.novelty),
    level: opt(sweepPaperRow.level),
    prereqHeavy: opt(sweepPaperRow.prereq_heavy),
    importance: opt(sweepPaperRow.importance),
    rankScore: opt(sweepPaperRow.rank_score),
    rank: sweepPaperRow.rank === null ? undefined : Number(sweepPaperRow.rank),
  };
}

export interface SweepRow {
  id: number;
  scheduled_run_id: number | null;
  trigger: string;
  status: SweepStatus;
  phase: Phase;
  orientation: number;
  queries_json: string;
  window_since: string | null;
  counts_json: string;
  phases_json: string;
  attempts: number;
  next_retry_at: number | null;
  error: string | null;
  conversation_id: number | null;
  submission_id: number | null;
  completion_json: string | null;
  cost_json: string | null;
  started_at: string;
  ended_at: string | null;
}

export function toRecord(sweepRow: SweepRow): SweepRecord {
  return {
    id: Number(sweepRow.id),
    scheduledRunId: sweepRow.scheduled_run_id === null ? undefined : Number(sweepRow.scheduled_run_id),
    trigger: sweepRow.trigger,
    status: sweepRow.status,
    phase: sweepRow.phase,
    orientation: !!sweepRow.orientation,
    queries: JSON.parse(sweepRow.queries_json),
    windowSince: opt(sweepRow.window_since),
    counts: JSON.parse(sweepRow.counts_json),
    phases: JSON.parse(sweepRow.phases_json),
    attempts: Number(sweepRow.attempts),
    nextRetryAt: sweepRow.next_retry_at === null ? undefined : Number(sweepRow.next_retry_at),
    error: opt(sweepRow.error),
    conversationId: sweepRow.conversation_id === null ? undefined : Number(sweepRow.conversation_id),
    submissionId: sweepRow.submission_id === null ? undefined : Number(sweepRow.submission_id),
    completion: sweepRow.completion_json ? JSON.parse(sweepRow.completion_json) : undefined,
    cost: sweepRow.cost_json ? JSON.parse(sweepRow.cost_json) : undefined,
    startedAt: sweepRow.started_at,
    endedAt: opt(sweepRow.ended_at),
  };
}

/** What the scheduled run records as the reason a sweep ended. */
export function runReason(status: SweepStatus, error: string | undefined): string | null {
  if (status === "failed") return error ?? null;
  return status === "no_new_papers" ? "no new papers" : null;
}
