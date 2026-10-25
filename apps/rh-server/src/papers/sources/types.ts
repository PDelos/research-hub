// What every source client implements.
import type { PoliteHttp } from "../http.ts";
import type { SourceName, SourcePaper } from "../store.ts";

export interface SourceQuery {
  query: string;
  /** Inclusive YYYY-MM-DD bounds. */
  since?: string;
  until?: string;
  limit: number;
  /** Time for all attempts at this source (interactive: 60 s). */
  budgetMs?: number;
}

export interface PaperSource {
  readonly name: SourceName;
  search(q: SourceQuery): Promise<SourcePaper[]>;
}

export interface SourceDeps {
  http: PoliteHttp;
}

/** Keep quoted phrases together and drop characters the source query languages treat specially. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (m[1] ?? m[2])
      .replace(/[^\p{L}\p{N}\s.+-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (term && !/^(and|or|not)$/i.test(term)) terms.push(m[1] ? `"${term}"` : term);
  }
  return terms;
}

/** Inside the inclusive date window (papers without a date are kept only when there is no window). */
export function inWindow(date: string | undefined, since?: string, until?: string): boolean {
  if (!since && !until) return true;
  if (!date) return false;
  return (!since || date >= since) && (!until || date <= until);
}
