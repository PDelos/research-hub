// Reading the web research's answers in the weekly upgrade: plain-text reasons and the JSON arrays models wrap in prose.
/** A reason as plain text: web answers cite inline as markdown links, which the report lists separately. */
export function plainReason(text: unknown, max = 300): string {
  return String(text ?? "")
    .replace(/\s*\(?\[[^\]]*\]\([^)]*\)\)?/g, "")
    .trim()
    .slice(0, max);
}

/** Parse the first JSON array in a model's answer (it may be wrapped in prose or a code fence). */
export function jsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
