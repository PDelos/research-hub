// Small formatters shared by the browser, the TUI and the CLI. The UI rule: no dashes or dots as punctuation.
/** A token count in short form: 1.5M, 12k, 950. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

export function usd(amount: number | undefined): string {
  const dollars = amount ?? 0;
  if (dollars === 0) return "$0";
  // Small amounts (Jev calls, embeddings) keep two significant digits: $0.000014, $0.00000050.
  if (dollars < 0.01) return `$${dollars.toFixed(Math.min(8, 1 - Math.floor(Math.log10(dollars))))}`;
  return `$${dollars.toFixed(2)}`;
}

export function ms(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m ${Math.round((value % 60_000) / 1000)}s`;
}

export function ago(at: number | string | undefined, now = Date.now()): string {
  if (at === undefined) return "";
  const time = typeof at === "number" ? at : Date.parse(at);
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
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
