// Compaction points, shared by the server, the browser context bar and the TUI. Pure TypeScript.
//
// pi-durable blocks the next request ("force", the agent waits) above contextWindow - reserveTokens,
// and starts a background summary backgroundTokens below that. We store the two points the UI drags.

export interface CompactionPoints {
  /** A background summary starts here, while the agent keeps working. */
  background: number;
  /** The next request waits for a summary here. */
  force: number;
}

export interface CompactionPolicyShape {
  enabled: boolean;
  reserveTokens: number;
  backgroundTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_POINTS: CompactionPoints = { background: 100_000, force: 200_000 };
export const STEP = 512;
export const MIN_BACKGROUND = 4_096;
export const GAP = 1_024;
/** Room always kept for the answer above the force point. */
export const MIN_RESERVE = 16_384;
export const KEEP_RECENT = 20_000;

export function toPolicy(
  window: number,
  points: CompactionPoints = DEFAULT_POINTS,
  enabled = true,
  keepRecentTokens = KEEP_RECENT,
): CompactionPolicyShape {
  const fitted = fit(window, points);
  return {
    enabled,
    reserveTokens: window - fitted.force,
    backgroundTokens: fitted.force - fitted.background,
    keepRecentTokens,
  };
}

export function fromPolicy(
  window: number,
  policy: Pick<CompactionPolicyShape, "reserveTokens" | "backgroundTokens">,
): CompactionPoints {
  const force = window - policy.reserveTokens;
  return { force, background: force - policy.backgroundTokens };
}

export function fits(window: number, p: CompactionPoints): boolean {
  return (
    p.background >= MIN_BACKGROUND &&
    p.force - p.background >= GAP &&
    window - p.force >= MIN_RESERVE
  );
}

/** Clamp points into a window: keep the reserve and the gap. */
export function fit(window: number, p: CompactionPoints): CompactionPoints {
  const force = Math.min(Math.round(p.force), window - MIN_RESERVE);
  const background = Math.max(MIN_BACKGROUND, Math.min(Math.round(p.background), force - GAP));
  return { background, force: Math.max(force, background + GAP) };
}

/** Snap a dragged point to STEP tokens (UI only). */
export const snap = (tokens: number) => Math.round(tokens / STEP) * STEP;

/** Why a requested change is rejected, or undefined when it is valid. */
export function validatePoints(window: number, p: CompactionPoints): string | undefined {
  if (!Number.isInteger(p.background) || !Number.isInteger(p.force))
    return "Compaction points must be whole token counts.";
  if (p.background < MIN_BACKGROUND)
    return `The background point must be at least ${MIN_BACKGROUND} tokens.`;
  if (p.force - p.background < GAP)
    return `The background point must sit at least ${GAP} tokens below the force point.`;
  if (window - p.force < MIN_RESERVE)
    return `The force point must leave at least ${MIN_RESERVE} tokens of the ${window} token window.`;
  return undefined;
}

export const k = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(tokens / 1000)}k`;
