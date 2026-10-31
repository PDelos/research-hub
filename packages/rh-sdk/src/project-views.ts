// What the hub tells clients about the project (v0.1–v0.5): the charter, the schedule, sweeps and cards, the
// knowledge base.

export type ProjectStatus = "needs-brief" | "charter-review" | "active" | "paused";

export interface ProjectOverview {
  name: string;
  status: ProjectStatus;
  charterVersion: number | null;
  hasDraft: boolean;
  charterRun: "running" | "done" | "failed" | null;
  paused: { since: string } | null;
  /** review is the weekly digest; nightly is the cycle's nightly run (v1.1). */
  next: { sweep: string | null; nightly: string | null; review: string | null; timeZone: string };
  monthCostUsd: number;
}

export interface CharterBody {
  questions: { id: string; text: string; weight: number }[];
  concepts: string[];
  subAreas: string[];
  queries: { text: string; weight: number }[];
  outOfScope: string[];
}

export interface CharterRecord {
  id: number;
  status: "draft" | "approved" | "superseded";
  version: number | null;
  charter: CharterBody;
  source: "agent" | "user";
  createdAt: string;
  approvedAt: string | null;
}

export interface ScopingQuestion {
  id: number;
  round: number;
  text: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface CharterView {
  status: ProjectStatus;
  draft: CharterRecord | null;
  approved: CharterRecord | null;
  versions: { version: number; approvedAt: string; source: string }[];
  questions: ScopingQuestion[];
  questionsLeft: number;
  run: {
    id: number;
    kind: "draft" | "revision";
    status: "running" | "done" | "failed";
    reason?: string;
    invalidSaves: number;
    startedAt: string;
    endedAt?: string;
  } | null;
}

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface ScheduleSettings {
  timeZone: string;
  sweep: { enabled: boolean; time: string };
  /** The nightly run of the daily cycle (v1.1). */
  nightly: { enabled: boolean; time: string };
  /** The weekly digest (stored as the review kind). */
  review: { enabled: boolean; weekday: Weekday; time: string };
}

export type RunKind = "sweep" | "nightly" | "review";

export interface ScheduledRun {
  id: number;
  kind: RunKind;
  slot: string;
  slotAt: number | null;
  trigger: "scheduled" | "manual";
  status: "requested" | "running" | "done" | "failed" | "skipped";
  reason: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- sweeps and cards (v0.3)

export type SweepPhase = "plan" | "gather" | "dedupe" | "gate" | "enrich" | "level" | "rank" | "cards";
export type SweepStatus = "running" | "completed" | "no_new_papers" | "failed";

export interface SweepCost {
  jevUsd: number;
  jevCalls: number;
  embeddingUsd: number;
  embeddingCalls: number;
  modelUsd: number;
  totalUsd: number;
}

export interface SweepPhaseRecord {
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt?: string;
  attempts: number;
  counts?: Record<string, number>;
  error?: string;
  detail?: unknown;
}

export interface SweepSummary {
  id: number;
  trigger: string;
  status: SweepStatus;
  phase: SweepPhase;
  orientation: boolean;
  counts: Record<string, number>;
  error?: string;
  nextRetryAt?: number;
  cost?: SweepCost;
  cards: number;
  startedAt: string;
  endedAt?: string;
}

export interface SweepPaperView {
  paperId: number;
  title: string;
  status: string;
  reason?: string;
  borderline: boolean;
  /** An exploration pick: least like the papers you liked (v1.1). */
  exploration: boolean;
  relevance?: number;
  level?: string;
  kind?: string;
  rank?: number;
  rankScore?: number;
}

export interface SweepDetail extends SweepSummary {
  queries: { text: string; weight: number; variant?: string }[];
  windowSince?: string;
  phases: Partial<Record<SweepPhase, SweepPhaseRecord>>;
  completion?: { presented: number[]; skipped: { paperId: number; reason: string }[] };
  papers: SweepPaperView[];
}

export interface PaperMeta {
  id: number;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  server?: string;
  link?: string;
  citations?: number;
  abstract?: string;
}

export interface CardView {
  id: number;
  sweepId: number;
  rank?: number;
  summary: string;
  relevance: number;
  relevanceReason: string;
  trust: number;
  trustReason: string;
  value: number;
  valueReason: string;
  level: string;
  matchedQuestion?: { id: string; text: string };
  borderline: boolean;
  /** An exploration pick: least like the papers you liked (v1.1). */
  exploration: boolean;
  createdAt: string;
  paper: PaperMeta;
  judgment: JudgmentView | null;
}

export type Verdict = "up" | "down" | "star";

export interface JudgmentView {
  verdict: Verdict;
  reason?: string;
  reasonKind?: string;
  ruleStatus: "none" | "candidate" | "unclassified" | "pending";
  updatedAt: string;
}

export interface WeightEffect {
  kind: "question" | "query" | "source";
  key: string;
  before: number;
  after: number;
}

export interface WeightView {
  kind: "question" | "query" | "source";
  key: string;
  base: number;
  value: number;
}

export interface PrecisionPoint {
  sweepId: number;
  startedAt: string;
  top: number;
  judged: number;
  good: number;
  precision: number | null;
}

export interface CardDetail extends CardView {
  weightEffects: WeightEffect[];
  details: {
    decisions: Record<string, { version: number; answers: unknown }>;
    inputs: Record<string, unknown>;
    formulas: Record<string, string>;
  };
}

export interface CardGroup {
  sweep: SweepSummary;
  cards: CardView[];
}

export interface SweepSettings {
  cardsPerSweep: number;
}

// ---------------------------------------------------------------- knowledge base (v0.5)

export interface KbPaper {
  paperId: number;
  cardId: number;
  stem: string | null;
  title: string;
  year?: number;
  venue?: string;
  level?: string;
  reason?: string;
  status: "pending" | "cancelled" | "done" | "failed";
  statusReason?: string;
  addedAt: string;
}

export interface KbNote {
  stem: string;
  path: string;
  properties: Record<string, unknown>;
  body: string;
}

export interface KbSearchHit {
  path: string;
  stem: string;
  title: string;
  excerpt: string;
}
