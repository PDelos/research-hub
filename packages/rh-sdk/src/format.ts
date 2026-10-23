// Small formatters shared by the browser, the TUI and the CLI. The UI rule: no dashes or dots as punctuation.
export const k = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(Math.round(tokens));

export function usd(amount: number | undefined): string {
  const n = amount ?? 0;
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function ms(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const m = Math.floor(value / 60_000);
  return `${m}m ${Math.round((value % 60_000) / 1000)}s`;
}

export function ago(at: number | string | undefined, now = Date.now()): string {
  if (at === undefined) return "";
  const t = typeof at === "number" ? at : Date.parse(at);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Model and source text for display: dashes become commas, bullet dots and ellipses disappear, whitespace collapses. */
export function cleanText(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]+-[ \t]+/g, ", ")
    .replace(/[·•]\s*/g, "")
    .replace(/\s*(\.{3,}|…)/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}
