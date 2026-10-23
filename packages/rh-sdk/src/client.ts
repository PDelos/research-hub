// A small fetch client for the hub API, used by the browser (through the UI proxy, no token) and by tests and
// scripts (with a bearer token).
import { RhError, type ErrorCode } from "./errors.ts";
import type { AgentState, CostTotals, Frame, Health, Info, JevPing, RunDetail, RunSummary, SendResult } from "./frames.ts";
import { readSse } from "./sse.ts";

export interface ClientOptions {
  /** Base URL including the API prefix, e.g. http://127.0.0.1:4850/v1 or /ui/v1. */
  base: string;
  token?: string;
  fetch?: typeof fetch;
}

export class HubClient {
  private readonly f: typeof fetch;
  constructor(private readonly options: ClientOptions) {
    this.f = options.fetch ?? fetch.bind(globalThis);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.options.base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new RhError("offline", "The hub cannot be reached", 0, { cause: error });
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new RhError((e.code as ErrorCode) ?? "internal", e.message ?? `HTTP ${res.status}`, res.status);
    }
    return json as T;
  }

  health = () => this.call<Health>("GET", "/health");
  info = () => this.call<Info>("GET", "/info");
  agent = (slug: string) => this.call<AgentState>("GET", `/p/${slug}/agent`);
  send = (slug: string, content: string, opts: { requestId?: string; waitMs?: number } = {}) =>
    this.call<SendResult>("POST", `/p/${slug}/chat`, { content, ...opts });
  runs = (slug: string, limit = 50) => this.call<RunSummary[]>("GET", `/p/${slug}/runs?limit=${limit}`);
  run = (slug: string, id: number) => this.call<RunDetail>("GET", `/p/${slug}/runs/${id}`);
  usage = (slug: string) => this.call<CostTotals>("GET", `/p/${slug}/usage`);
  jevPing = (slug: string) => this.call<JevPing>("POST", `/p/${slug}/jev/ping`, {});

  /** Follow a project's stream until the signal aborts. */
  async *stream(slug: string, signal?: AbortSignal): AsyncGenerator<Frame> {
    const res = await this.f(`${this.options.base}/p/${slug}/stream`, {
      headers: this.options.token ? { authorization: `Bearer ${this.options.token}` } : {},
      signal,
    });
    if (!res.ok || !res.body) throw new RhError("unavailable", `Stream failed: HTTP ${res.status}`, res.status);
    for await (const message of readSse(res.body)) yield JSON.parse(message.data) as Frame;
  }
}
