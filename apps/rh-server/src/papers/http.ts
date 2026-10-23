// Polite HTTP for paper sources: per-host pacing (arXiv: 1 request per 3 s), a timeout per attempt, and retries on
// HTTP 429/5xx or network errors honoring Retry-After, within a time budget (spec paper-sources: Polite rate
// limiting, Source failure isolation).
import { VERSION } from "../version.ts";
import type { Logger } from "../logger.ts";

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface RequestOptions {
  /** Source name for errors and logs. */
  source: string;
  headers?: Record<string, string>;
  /** Attempts including the first (default 3). */
  attempts?: number;
  /** Total time for all attempts and waits (default 60 s, the interactive budget). */
  budgetMs?: number;
  /** Per-attempt timeout (default 20 s, never beyond the remaining budget). */
  timeoutMs?: number;
}

export interface PoliteHttpOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum milliseconds between requests to a host. */
  pacing?: Record<string, number>;
  contactEmail?: string;
  log?: Logger;
}

export const DEFAULT_PACING: Record<string, number> = {
  "export.arxiv.org": 3_000,
  "api.openalex.org": 100,
  "www.ebi.ac.uk": 100,
  "api.semanticscholar.org": 1_000,
};

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class PoliteHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pacing: Record<string, number>;
  private readonly nextSlot = new Map<string, number>();
  readonly userAgent: string;

  constructor(private readonly options: PoliteHttpOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pacing = { ...DEFAULT_PACING, ...options.pacing };
    this.userAgent = `research-hub/${VERSION}${options.contactEmail ? ` (mailto:${options.contactEmail})` : ""}`;
  }

  get contactEmail(): string | undefined {
    return this.options.contactEmail;
  }

  async json<T>(url: string, options: RequestOptions): Promise<T> {
    const response = await this.request(url, { ...options, headers: { accept: "application/json", ...options.headers } });
    try {
      return (await response.json()) as T;
    } catch {
      throw new SourceError(options.source, "the response was not valid JSON");
    }
  }

  async text(url: string, options: RequestOptions): Promise<string> {
    return (await this.request(url, options)).text();
  }

  /** GET with pacing and retries; a 404 resolves to a Response with status 404 for the caller to read as "not found". */
  async request(url: string, options: RequestOptions): Promise<Response> {
    const attempts = options.attempts ?? 3;
    const budget = options.budgetMs ?? 60_000;
    const started = this.now();
    const host = new URL(url).host;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.pace(host);
      const remaining = budget - (this.now() - started);
      if (remaining <= 0) break;
      let retryAfter: number | undefined;
      try {
        const response = await this.fetchImpl(url, {
          headers: { "user-agent": this.userAgent, ...options.headers },
          signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 20_000, remaining)),
        });
        if (response.ok || response.status === 404) return response;
        lastError = `HTTP ${response.status}`;
        if (!RETRYABLE.has(response.status)) {
          await response.body?.cancel();
          throw new SourceError(options.source, lastError, response.status);
        }
        retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
        await response.body?.cancel();
        if (attempt === attempts) throw new SourceError(options.source, `${lastError} after ${attempts} attempts`, response.status);
      } catch (error) {
        if (error instanceof SourceError) throw error;
        lastError = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : error.message) : String(error);
        if (attempt === attempts) break;
      }
      const wait = retryAfter ?? 2_000 * 2 ** (attempt - 1);
      if (this.now() - started + wait >= budget) {
        lastError += `; the next retry (in ${Math.round(wait / 1000)} s) would exceed the ${Math.round(budget / 1000)} s budget`;
        break;
      }
      this.options.log?.debug("papers.http_retry", { source: options.source, attempt, waitMs: wait, error: lastError });
      await this.sleep(wait);
    }
    throw new SourceError(options.source, lastError || "no attempt fit the time budget");
  }

  /** Wait for this host's next free slot; concurrent callers get consecutive slots. */
  private async pace(host: string): Promise<void> {
    const gap = this.pacing[host] ?? 0;
    if (!gap) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + gap);
    if (slot > now) await this.sleep(slot - now);
  }
}

/** Retry-After in milliseconds from seconds or an HTTP date; capped at 60 s. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 60_000) : undefined;
}
