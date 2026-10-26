// A small fetch client for the hub API, used by the browser (through the UI proxy, no token) and by tests and
// scripts (with a bearer token).
import { RhError, type ErrorCode } from "./errors.ts";
import type {
  AgentState,
  CardDetail,
  CardGroup,
  KbNote,
  KbPaper,
  KbSearchHit,
  PluginContributionsView,
  PluginDetails,
  PluginHistoryEntry,
  PluginInstallPlan,
  PluginInstallSource,
  PluginList,
  PrecisionPoint,
  Verdict,
  WeightView,
  CharterBody,
  CharterRecord,
  CharterView,
  CostTotals,
  Frame,
  Health,
  Info,
  JevPing,
  ProjectOverview,
  RunDetail,
  RunSummary,
  ScheduledRun,
  ScheduleSettings,
  SendResult,
  SweepDetail,
  SweepSettings,
  SweepSummary,
} from "./frames.ts";
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
      throw new RhError((e.code as ErrorCode) ?? "internal", e.message ?? `HTTP ${res.status}`, res.status, {
        details: e.details,
      });
    }
    return json as T;
  }

  health = () => this.call<Health>("GET", "/health");
  info = () => this.call<Info>("GET", "/info");
  agent = () => this.call<AgentState>("GET", "/agent");
  send = (content: string, opts: { requestId?: string; waitMs?: number } = {}) =>
    this.call<SendResult>("POST", "/chat", { content, ...opts });
  runs = (limit = 50) => this.call<RunSummary[]>("GET", `/runs?limit=${limit}`);
  run = (id: number) => this.call<RunDetail>("GET", `/runs/${id}`);
  usage = () => this.call<CostTotals>("GET", "/usage");
  jevPing = () => this.call<JevPing>("POST", "/jev/ping", {});

  project = () => this.call<ProjectOverview>("GET", "/project");
  pause = () => this.call<{ status: string }>("POST", "/project/pause", {});
  resume = () => this.call<{ status: string }>("POST", "/project/resume", {});
  brief = () => this.call<{ brief: string | null; chars: number; status: string }>("GET", "/brief");
  setBrief = (brief: string) => this.call<CharterView>("PUT", "/brief", { brief });
  charter = () => this.call<CharterView>("GET", "/charter");
  charterVersion = (n: number) => this.call<CharterRecord>("GET", `/charter/versions/${n}`);
  editCharter = (charter: CharterBody) => this.call<CharterView>("PUT", "/charter", { charter });
  answer = (answers: { id: number; answer: string }[]) =>
    this.call<CharterView>("POST", "/charter/answers", { answers });
  approve = () => this.call<CharterView>("POST", "/charter/approve", {});
  retryCharter = () => this.call<CharterView>("POST", "/charter/retry", {});
  schedule = () => this.call<ScheduleSettings>("GET", "/schedule");
  setSchedule = (
    patch: Partial<{
      sweep: Partial<ScheduleSettings["sweep"]>;
      nightly: Partial<ScheduleSettings["nightly"]>;
      review: Partial<ScheduleSettings["review"]>;
    }>,
  ) => this.call<ScheduleSettings>("PUT", "/schedule", patch);
  scheduledRuns = (limit = 100) => this.call<ScheduledRun[]>("GET", `/scheduled-runs?limit=${limit}`);

  // Sweeps and cards (v0.3)
  cards = (limit = 100) => this.call<{ groups: CardGroup[] }>("GET", `/cards?limit=${limit}`);
  card = (id: number) => this.call<CardDetail>("GET", `/cards/${id}`);
  sweeps = (limit = 50) => this.call<SweepSummary[]>("GET", `/sweeps?limit=${limit}`);
  sweep = (id: number) => this.call<SweepDetail>("GET", `/sweeps/${id}`);
  sweepSettings = () => this.call<SweepSettings>("GET", "/sweep-settings");
  setSweepSettings = (patch: Partial<SweepSettings>) => this.call<SweepSettings>("PUT", "/sweep-settings", patch);

  // Feedback (v0.4)
  judge = (cardId: number, verdict: Verdict, reason?: string) =>
    this.call<CardDetail>("PUT", `/cards/${cardId}/judgment`, { verdict, ...(reason ? { reason } : {}) });
  clearJudgment = (cardId: number) => this.call<CardDetail>("DELETE", `/cards/${cardId}/judgment`);
  precision = () => this.call<PrecisionPoint[]>("GET", "/feedback/precision");
  weights = () => this.call<WeightView[]>("GET", "/weights");

  // Knowledge base (v0.5)
  kbPapers = () => this.call<KbPaper[]>("GET", "/kb/papers");
  kbNote = (stem: string) => this.call<KbNote>("GET", `/kb/notes/${encodeURIComponent(stem)}`);
  kbSearch = (query: string, limit = 8) =>
    this.call<KbSearchHit[]>("GET", `/kb/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  triggerRun = (kind: "sweep" | "nightly" | "review") => this.call<ScheduledRun>("POST", `/runs/${kind}`, {});

  // Plugins (v1.0)
  plugins = () => this.call<PluginList>("GET", "/plugins");
  plugin = (id: string) => this.call<PluginDetails>("GET", `/plugins/${encodeURIComponent(id)}`);
  contributions = () => this.call<PluginContributionsView>("GET", "/plugins/contributions");
  pluginHistory = (limit = 100) => this.call<PluginHistoryEntry[]>("GET", `/plugins/history?limit=${limit}`);
  /** Prepare an install: returns what the plugin contributes and asks for; nothing changes until approved. */
  prepareInstall = (source: PluginInstallSource) =>
    this.call<PluginInstallPlan>("POST", "/plugins/install", { source });
  approveInstall = (planId: string) =>
    this.call<PluginDetails>("POST", `/plugins/install/${encodeURIComponent(planId)}/approve`, {});
  cancelInstall = (planId: string) => this.call<void>("DELETE", `/plugins/install/${encodeURIComponent(planId)}`);
  /** Disabling a plugin others depend on fails (conflict, details: the dependents) unless `cascade`. */
  setPluginEnabled = (id: string, enabled: boolean, cascade = false) =>
    this.call<PluginDetails>("POST", `/plugins/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
      cascade,
    });
  /** Change settings (null removes a saved value); invalid values fail with the setting and the rule. */
  setPluginSettings = (id: string, values: Record<string, unknown>) =>
    this.call<PluginDetails>("PUT", `/plugins/${encodeURIComponent(id)}/settings`, { values });
  uninstallPlugin = (id: string, deleteData = false) =>
    this.call<void>("DELETE", `/plugins/${encodeURIComponent(id)}${deleteData ? "?deleteData=true" : ""}`);
  rollbackPlugins = (commit: string) => this.call<PluginList>("POST", "/plugins/rollback", { commit });
  /** Tell the hub a tab was opened, so plugins activated by onView:<tab> start. */
  openView = (tab: string) => this.call<void>("POST", `/plugins/views/${encodeURIComponent(tab)}/open`, {});

  /** Follow the project's stream until the signal aborts. */
  async *stream(signal?: AbortSignal): AsyncGenerator<Frame> {
    const res = await this.f(`${this.options.base}/stream`, {
      headers: this.options.token ? { authorization: `Bearer ${this.options.token}` } : {},
      signal,
    });
    if (!res.ok || !res.body) throw new RhError("unavailable", `Stream failed: HTTP ${res.status}`, res.status);
    for await (const message of readSse(res.body)) yield JSON.parse(message.data) as Frame;
  }
}
