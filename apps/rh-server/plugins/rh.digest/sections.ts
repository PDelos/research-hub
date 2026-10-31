// Digest sections that other plugins provide: the harness's view of the week, the weekly upgrade's runs, and the
// knowledge review's charter proposals. Each is left out when its plugin is not running.
import type { DigestBody } from "@rh/sdk";
import type { HarnessExports } from "../rh.harness/main.ts";
import type { KnowledgeExports } from "../rh.knowledge/main.ts";
import type { UpgradesExports } from "../rh.upgrades/main.ts";

export interface Period {
  from: string;
  to: string;
}

const within = (at: string | null, { from, to }: Period) => at !== null && at >= from && at < to;

/** The judge's agreement and the week's replays (the weekly upgrade's replays are in its own section). */
export function qualitySection(harness: HarnessExports, period: Period): NonNullable<DigestBody["quality"]> {
  const quality = harness.quality();
  return {
    judge: quality.judge
      ? { agreement: quality.judge.agreement, cases: quality.judge.cases, trusted: quality.judge.trusted }
      : null,
    replays: harness
      .replays(200)
      .filter((r) => within(r.createdAt, period) && !r.requestedBy.startsWith("upgrade-"))
      .map((r) => ({
        id: r.id,
        variant: r.variant as Record<string, unknown>,
        verdict: r.report.verdict,
        heldOutDiff: r.report.heldOut.diff,
        low: r.report.heldOut.low,
        high: r.report.heldOut.high,
        requestedBy: r.requestedBy,
        createdAt: r.createdAt,
      })),
  };
}

/** Upgrade runs by when they finished: a run the digest's night started is in next week's digest. */
export function upgradeSection(upgrades: UpgradesExports, period: Period): NonNullable<DigestBody["upgrade"]> {
  const proposals = upgrades.proposals();
  return {
    runs: upgrades
      .runs(50)
      .filter((u) => within(u.finishedAt, period))
      .map((u) => ({
        id: u.id,
        focus: u.focus,
        reason: u.reason,
        status: u.status,
        result: u.report?.result ?? "",
        tried: u.report?.tried.length ?? 0,
        proposals: proposals
          .filter((p) => p.runId === u.id)
          .map((p) => ({ id: p.id, kind: p.kind, status: p.status, commit: p.commit })),
        startedAt: u.startedAt,
      })),
  };
}

/** Charter proposals open now or decided this week, the review's notes and the finders' record. */
export async function charterSection(
  knowledge: KnowledgeExports,
  period: Period,
  reviewNotes: string[],
): Promise<NonNullable<DigestBody["charter"]>> {
  return {
    proposals: knowledge.proposals().filter((p) => p.status === "proposed" || within(p.decidedAt, period)),
    reviewNotes,
    finders: await knowledge.finders(),
  };
}
