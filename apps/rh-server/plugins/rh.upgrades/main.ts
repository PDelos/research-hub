// Built-in plugin rh.upgrades (spec weekly-upgrade; design v1-4): once every `everyDays` days, after the nightly run,
// it works on exactly one focus chosen by Jev: the ranking slot (variants replayed on the user's judgments, the best
// "better" one applied as one undoable change), the embedder slot (cheap catalog models benchmarked on the fixed
// preset, a winner proposed for approval) or scouting add-ons (sources and integrations suggested from the web).
// It never changes the core or how a slot is measured.
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { HarnessExports, StoredReplay } from "../rh.harness/main.ts";
import type { SweepExports } from "../rh.sweep/main.ts";
import type { EmbedderExports, PapersExports } from "../rh.papers/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import { analyze, rankingGrid, type Analysis } from "./ranking.ts";
import { summarize } from "../rh.harness/main.ts";

export const FOCUSES = ["ranking", "embedder", "scout-addons"] as const;
export type Focus = (typeof FOCUSES)[number];
export const FOCUS_MIN_CONFIDENCE = 0.4;
/** Tokens one embedder benchmark embeds (the two samples and "your stars"), for the cost estimate. */
export const BENCHMARK_TOKENS_MILLIONS = 1.2;
const EMBED_CATALOG = "https://openrouter.ai/api/v1/embeddings/models";

export interface CatalogModel {
  id: string;
  created: number;
  contextLength: number;
  pricePerMillion: number;
  dimensionsParam: boolean;
  description: string;
}

export interface UpgradeReport {
  focus: Focus;
  reason: string;
  /** The ranking analysis, the embedder catalog filter, or the scout question. */
  analysis?: unknown;
  tried: { what: string; why?: string; verdict?: string; numbers?: Record<string, number | null>; note?: string }[];
  result: string;
}

export interface UpgradeRun {
  id: number;
  focus: Focus;
  reason: string;
  status: "running" | "done" | "failed";
  report: UpgradeReport | null;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: string;
}

export interface Proposal {
  id: number;
  runId: number;
  kind: "ranking" | "embedder";
  payload: Record<string, unknown>;
  /** applied: changed right away with undo (ranking); proposed: waits for the user (embedder). */
  status: "applied" | "proposed" | "approved" | "rejected";
  commit: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Suggestion {
  id: number;
  runId: number;
  name: string;
  url: string;
  reason: string;
  status: "open" | "dismissed";
  createdAt: string;
}

export class UpgradeInvalid extends Error {}

export interface UpgradesExports {
  /** Whether an upgrade is due now (enabled and `everyDays` since the last one; nightly runs drift, so 7 days ≈ 6.5). */
  due(now?: number): boolean;
  /** Whether a run is in progress. */
  busy(): boolean;
  run(options?: { focus?: Focus; requestedBy?: string }): Promise<UpgradeRun>;
  runs(limit?: number): UpgradeRun[];
  proposals(status?: Proposal["status"]): Proposal[];
  suggestions(includeDismissed?: boolean): Suggestion[];
  approve(id: number): Promise<Proposal>;
  reject(id: number): Proposal;
  dismiss(id: number): Suggestion;
  /** The focus Jev picks (or the rotation), with the reason. */
  chooseFocus(): Promise<{ focus: Focus; reason: string; costUsd: number }>;
}

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

export function activate(context: PluginContext): UpgradesExports {
  const host = hostOf(context);
  const { db } = host;
  const { rh } = context;
  const harness = context.exports["rh.harness"] as HarnessExports;
  const sweep = context.exports["rh.sweep"] as SweepExports;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const provider = context.exports["rh.provider-openrouter"] as ProviderExports;
  const T = { runs: rh.db.table("runs"), proposals: rh.db.table("proposals"), suggestions: rh.db.table("suggestions") };
  rh.db.migrate([
    {
      version: 1,
      sql: `CREATE TABLE ${T.runs} (id INTEGER PRIMARY KEY, focus TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
              report_json TEXT, cost_usd REAL NOT NULL DEFAULT 0, requested_by TEXT NOT NULL, started_at TEXT NOT NULL,
              finished_at TEXT);
            CREATE TABLE ${T.proposals} (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, kind TEXT NOT NULL,
              payload_json TEXT NOT NULL, status TEXT NOT NULL, commit_id TEXT, created_at TEXT NOT NULL, decided_at TEXT);
            CREATE TABLE ${T.suggestions} (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, name TEXT NOT NULL,
              url TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)`,
    },
  ]);
  // A run interrupted by a restart did not finish.
  db.prepare(`UPDATE ${T.runs} SET status = 'failed', finished_at = ? WHERE status = 'running'`).run(
    new Date().toISOString(),
  );

  const setting = <V>(key: string) => context.settings[key] as V;
  const now = () => new Date().toISOString();
  type RunRow = {
    id: number;
    focus: Focus;
    reason: string;
    status: UpgradeRun["status"];
    report_json: string | null;
    cost_usd: number;
    requested_by: string;
    started_at: string;
    finished_at: string | null;
  };
  const toRun = (r: RunRow): UpgradeRun => ({
    id: Number(r.id),
    focus: r.focus,
    reason: r.reason,
    status: r.status,
    report: r.report_json ? (JSON.parse(r.report_json) as UpgradeReport) : null,
    costUsd: r.cost_usd,
    requestedBy: r.requested_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  });
  type ProposalRow = {
    id: number;
    run_id: number;
    kind: Proposal["kind"];
    payload_json: string;
    status: Proposal["status"];
    commit_id: string | null;
    created_at: string;
    decided_at: string | null;
  };
  const toProposal = (r: ProposalRow): Proposal => ({
    id: Number(r.id),
    runId: Number(r.run_id),
    kind: r.kind,
    payload: JSON.parse(r.payload_json),
    status: r.status,
    commit: r.commit_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  });
  type SuggestionRow = {
    id: number;
    run_id: number;
    name: string;
    url: string;
    reason: string;
    status: Suggestion["status"];
    created_at: string;
  };
  const toSuggestion = (r: SuggestionRow): Suggestion => ({
    id: Number(r.id),
    runId: Number(r.run_id),
    name: r.name,
    url: r.url,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  });
  const proposal = (id: number) => {
    const row = db.prepare(`SELECT * FROM ${T.proposals} WHERE id = ?`).get(id) as ProposalRow | undefined;
    if (!row) throw new UpgradeInvalid(`no proposal ${id}`);
    return toProposal(row);
  };
  const addProposal = (
    runId: number,
    kind: Proposal["kind"],
    payload: object,
    status: Proposal["status"],
    commit: string | null = null,
  ) => {
    const r = db
      .prepare(
        `INSERT INTO ${T.proposals} (run_id, kind, payload_json, status, commit_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, kind, JSON.stringify(payload), status, commit, now(), status === "applied" ? now() : null);
    return proposal(Number(r.lastInsertRowid));
  };
  /** What the run spent: embeddings and Jev calls since it started, plus the web research. */
  const spentSince = (since: string) =>
    Number(
      (
        db
          .prepare(
            "SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM embedding_calls WHERE created_at >= ?) + (SELECT COALESCE(SUM(CASE WHEN cost_source IN ('reported','estimated') THEN cost_usd END), 0) FROM jev_calls WHERE created_at >= ?) c",
          )
          .get(since, since) as { c: number }
      ).c,
    );

  // Web research is paid per request (OpenRouter's web plugin); it counts in the run's cost and the plugin's budget.
  let researchUsd = 0;
  const research: ProviderExports["research"] = async (prompt, o) => {
    host.services.budgets.assertWithin(context.id, context.manifest.permissions.budgetUsdPerDay);
    const r = await provider.research(prompt, o);
    researchUsd += r.costUsd;
    if (r.costUsd) host.services.budgets.charge(context.id, r.costUsd);
    return r;
  };

  // --- Focus ---------------------------------------------------------------------------------------------------
  const lastRun = () =>
    (db.prepare(`SELECT * FROM ${T.runs} WHERE status = 'done' ORDER BY id DESC LIMIT 1`).get() as
      | RunRow
      | undefined) ?? undefined;
  const rotation = (): Focus => {
    const last = lastRun()?.focus;
    return last ? FOCUSES[(FOCUSES.indexOf(last) + 1) % FOCUSES.length] : FOCUSES[0];
  };
  const commentsSince = (since: string) => {
    try {
      return db
        .prepare("SELECT section, text FROM p_rh_digest__comments WHERE created_at >= ? ORDER BY id DESC LIMIT 20")
        .all(since) as { section: string; text: string }[];
    } catch {
      return [];
    }
  };
  const chooseFocus: UpgradesExports["chooseFocus"] = async () => {
    const since = lastRun()?.started_at ?? "1970-01-01";
    const comments = commentsSince(since);
    const ageDays = (iso?: string) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 86_400_000) : null);
    const slots = harness
      .slots()
      .filter((s) => s.id === "ranking" || s.id === "embedder")
      .map((s) => ({
        slot: s.id,
        active: s.active.name,
        lastResult: s.last?.result.label ?? "never measured",
        ageDays: ageDays(s.last?.createdAt),
      }));
    const a = analyze(db);
    const recent = (
      db.prepare(`SELECT focus FROM ${T.runs} WHERE status = 'done' ORDER BY id DESC LIMIT 3`).all() as {
        focus: string;
      }[]
    ).map((r) => r.focus);
    const fallback = rotation();
    try {
      const { answers, costUsd } = await rh.decisions.decide("upgrade-focus", {
        slots: JSON.stringify(slots),
        comments: comments.length ? JSON.stringify(comments) : "none",
        failures: JSON.stringify(a),
        recent: recent.length ? recent.join(", ") : "none",
      });
      const answer = answers.focus as { choice?: string; confidence?: number; reason?: string } | undefined;
      const choice = answer?.choice as Focus | undefined;
      if (choice && FOCUSES.includes(choice) && (answer?.confidence ?? 0) >= FOCUS_MIN_CONFIDENCE) {
        const quoted = comments.length ? ` Your comment: “${comments[0].text.slice(0, 200)}”.` : "";
        return {
          focus: choice,
          reason: `Chosen by Jev (confidence ${(answer?.confidence ?? 0).toFixed(2)}).${quoted}`,
          costUsd,
        };
      }
      return { focus: fallback, reason: "Jev was unsure, so the next focus in the rotation.", costUsd };
    } catch (error) {
      context.log.warn("upgrades.focus_failed", { error: String(error) });
      return { focus: fallback, reason: "The next focus in the rotation (Jev unavailable).", costUsd: 0 };
    }
  };

  // --- Ranking ---------------------------------------------------------------------------------------------------
  type Outcome = { report: Omit<UpgradeReport, "focus" | "reason"> };
  const ranking = async (runId: number): Promise<Outcome> => {
    const a: Analysis = analyze(db);
    const grid = rankingGrid(sweep.currentSettings(), a);
    const tried: UpgradeReport["tried"] = [];
    let best: { replay: StoredReplay; why: string } | undefined;
    for (const candidate of grid) {
      const r = await harness.replay(candidate.variant, `upgrade-${runId}`);
      tried.push({
        what: JSON.stringify(candidate.variant),
        why: candidate.why,
        verdict: r.report.verdict,
        numbers: { heldOutDiff: r.report.heldOut.diff, heldOutLow: r.report.heldOut.low },
        note: summarize(r.report),
      });
      if (r.report.verdict === "not enough data") break;
      if (r.report.verdict === "better" && (!best || r.report.heldOut.low > best.replay.report.heldOut.low))
        best = { replay: r, why: candidate.why };
    }
    if (!best)
      return {
        report: {
          analysis: a,
          tried,
          result:
            tried[0]?.verdict === "not enough data"
              ? `Nothing changed: ${tried[0].note}`
              : "Nothing changed: no variant replayed as better.",
        },
      };
    await host.configure("rh.sweep", best.replay.variant as Record<string, unknown>, `proposal:upgrade-${runId}`);
    const commit = (await host.pluginHistory(1))[0]?.id ?? null;
    addProposal(
      runId,
      "ranking",
      { variant: best.replay.variant, replayId: best.replay.id, why: best.why },
      "applied",
      commit,
    );
    return {
      report: {
        analysis: a,
        tried,
        result: `Applied ${JSON.stringify(best.replay.variant)} (${best.why}); ${summarize(best.replay.report)} Undo it from the Upgrades tab or the digest.`,
      },
    };
  };

  // --- Embedder --------------------------------------------------------------------------------------------------
  const catalog = async (): Promise<CatalogModel[]> => {
    const body = await rh.http.json<{
      data?: {
        id: string;
        created?: number;
        context_length?: number;
        pricing?: { prompt?: string | number };
        supported_parameters?: string[];
        description?: string;
      }[];
    }>(EMBED_CATALOG);
    return (body.data ?? []).map((m) => ({
      id: m.id,
      created: m.created ?? 0,
      contextLength: m.context_length ?? 0,
      pricePerMillion: Number(m.pricing?.prompt ?? 0) * 1e6,
      dimensionsParam: (m.supported_parameters ?? []).includes("dimensions"),
      description: (m.description ?? "").slice(0, 300),
    }));
  };
  const embedder = async () => {
    const choice = host.services.contributions.activeContribution("papers.embedder", {});
    return host.exportsOf<EmbedderExports>(choice?.pluginId ?? "rh.embedder-openrouter");
  };
  const embedderRun = async (runId: number): Promise<Outcome> => {
    const active = (await embedder()).config();
    const maxPrice = setting<number>("maxEmbedPricePerMillion");
    const maxRun = setting<number>("maxRunUsd");
    const all = await catalog();
    const eligible = all.filter(
      (m) => m.id !== active.model && m.pricePerMillion <= maxPrice && m.contextLength >= 512,
    );
    const analysis = { catalog: all.length, eligible: eligible.length, maxPricePerMillion: maxPrice, active };
    if (!eligible.length)
      return {
        report: { analysis, tried: [], result: "Nothing changed: no other embedding model within the price limit." },
      };
    let shortlist: { id: string; reason: string }[] = [];
    let researchNote = "";
    try {
      const answer = await research(
        `Which of these OpenRouter embedding models is likely best for retrieving scientific papers (biology, bioinformatics, machine learning) by title and abstract? Search the web for recent benchmark results (e.g. MTEB, SciDocs). Answer only with a JSON array of at most 2 objects {"id": "<one of the ids>", "reason": "<one sentence>"}, best first.\n\nCurrent model: ${active.model}\nCandidates:\n${eligible
          .map((m) => `- ${m.id} ($${m.pricePerMillion.toFixed(3)}/M tokens): ${m.description}`)
          .join("\n")}`,
        { maxResults: 5 },
      );
      const ids = new Set(eligible.map((m) => m.id));
      shortlist = jsonArray(answer.text)
        .filter((x): x is { id: string; reason?: string } => !!x && typeof (x as { id?: unknown }).id === "string")
        .filter((x) => ids.has(x.id))
        .slice(0, 2)
        .map((x) => ({ id: x.id, reason: plainReason(x.reason) }));
      researchNote = shortlist.length ? "shortlisted by web research" : "web research named no catalog model";
    } catch (error) {
      researchNote = `web research unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
    if (!shortlist.length)
      shortlist = eligible
        .toSorted((x, y) => y.created - x.created)
        .slice(0, 2)
        .map((m) => ({ id: m.id, reason: "one of the newest models within the price limit" }));
    const tried: UpgradeReport["tried"] = [];
    // The active model's numbers: reuse a result younger than 30 days.
    const lastActive = harness
      .benchmarks("embedder", 20)
      .find((b) => b.candidate.model === active.model && b.candidate.dims === active.dims);
    const fresh = lastActive && Date.now() - Date.parse(lastActive.createdAt) < 30 * 86_400_000;
    const base = fresh ? lastActive : await harness.runBenchmark("embedder");
    const numbers = (r: typeof base) =>
      Object.fromEntries([...r.result.tasks.map((t) => [t.task, t.value] as const), ["mean", r.result.value] as const]);
    tried.push({
      what: `${active.model} (active, ${active.dims} dimensions)`,
      numbers: numbers(base),
      note: fresh ? "earlier result" : undefined,
    });
    const stars = (r: typeof base) => r.result.tasks.find((t) => t.task === "your-stars")?.value ?? null;
    let winner: { model: string; dims: number; record: typeof base; reason: string } | undefined;
    let spent = base.costUsd + researchUsd;
    for (const pick of shortlist) {
      const m = eligible.find((e) => e.id === pick.id)!;
      const estimate = BENCHMARK_TOKENS_MILLIONS * m.pricePerMillion;
      if (spent + estimate > maxRun) {
        tried.push({
          what: m.id,
          why: pick.reason,
          note: `skipped: about $${estimate.toFixed(2)} would pass the run's $${maxRun} cap`,
        });
        continue;
      }
      const dims = m.dimensionsParam ? active.dims : 0;
      try {
        const r = await harness.runBenchmark("embedder", { model: m.id, ...(dims ? { dims } : {}) });
        spent += r.costUsd;
        const gain = (r.result.value ?? 0) - (base.result.value ?? 0);
        const starsOk = stars(r) === null || stars(base) === null || stars(r)! >= stars(base)!;
        const wins = r.result.value !== null && base.result.value !== null && gain >= 0.02 && starsOk;
        tried.push({
          what: `${m.id} (${r.candidate.dims} dimensions)`,
          why: pick.reason,
          verdict: wins ? "better" : "not better",
          numbers: numbers(r),
        });
        if (wins && (!winner || (r.result.value ?? 0) > (winner.record.result.value ?? 0)))
          winner = { model: m.id, dims, record: r, reason: pick.reason };
      } catch (error) {
        tried.push({
          what: m.id,
          why: pick.reason,
          note: `failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (!winner)
      return {
        report: {
          analysis: { ...analysis, research: researchNote },
          tried,
          result: "Nothing changed: no candidate beat the active model by 0.02 nDCG@10 without losing on your stars.",
        },
      };
    const p = addProposal(
      runId,
      "embedder",
      {
        model: winner.model,
        dims: winner.dims,
        reason: winner.reason,
        mean: winner.record.result.value,
        activeMean: base.result.value,
        activeModel: active.model,
        activeDims: active.dims,
      },
      "proposed",
    );
    return {
      report: {
        analysis: { ...analysis, research: researchNote },
        tried,
        result: `Proposed ${winner.model} (${winner.dims || "native"} dimensions): mean nDCG@10 ${(winner.record.result.value ?? 0).toFixed(3)} vs ${(base.result.value ?? 0).toFixed(3)}. Approve it in the Upgrades tab (proposal ${p.id}); the papers are then re-embedded in the background.`,
      },
    };
  };

  // --- Scout -----------------------------------------------------------------------------------------------------
  const scout = async (runId: number): Promise<Outcome> => {
    const charter = db
      .prepare("SELECT body_json FROM charters WHERE status = 'approved' ORDER BY version DESC LIMIT 1")
      .get() as { body_json: string } | undefined;
    const body = charter
      ? (JSON.parse(charter.body_json) as { questions?: { text: string }[]; concepts?: unknown[] })
      : {};
    const installed = host.services.contributions.declaredContributions("papers.source").map((c) => c.id);
    const known = [...installed, ...suggestionsList(true).map((s) => s.name)];
    const answer = await research(
      `A self-hosted research assistant collects new scientific papers for these research questions:\n${
        (body.questions ?? []).map((q) => `- ${q.text}`).join("\n") || "- (no charter yet: AI and bioinformatics)"
      }\n\nIt already has these paper sources: ${installed.join(", ")}. Already suggested: ${known.join(", ") || "none"}.\nSearch the web for up to 5 free scholarly paper APIs or integrations (preprint servers, databases, citation graphs) it does not have yet that fit these questions. Answer only with a JSON array of objects {"name": "...", "url": "<official API or documentation link>", "reason": "<one sentence on why it fits>"}.`,
      { maxResults: 5 },
    );
    const lower = new Set(known.map((k) => k.toLowerCase()));
    const items = jsonArray(answer.text)
      .filter(
        (x): x is { name: string; url: string; reason?: string } =>
          !!x &&
          typeof (x as { name?: unknown }).name === "string" &&
          typeof (x as { url?: unknown }).url === "string" &&
          /^https?:\/\//.test((x as { url: string }).url),
      )
      .filter((x) => !lower.has(x.name.toLowerCase()))
      .slice(0, 5);
    for (const s of items)
      db.prepare(`INSERT INTO ${T.suggestions} (run_id, name, url, reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        runId,
        s.name.slice(0, 120),
        s.url.slice(0, 500),
        plainReason(s.reason, 500),
        now(),
      );
    return {
      report: {
        analysis: { installed, citations: answer.citations.slice(0, 10) },
        tried: items.map((s) => ({ what: s.name, why: plainReason(s.reason, 500), note: s.url })),
        result: items.length
          ? `${items.length} add-on suggestions listed in the Upgrades tab.`
          : "No new sources or integrations found.",
      },
    };
  };

  const suggestionsList = (includeDismissed = false) =>
    (
      db
        .prepare(`SELECT * FROM ${T.suggestions} ${includeDismissed ? "" : "WHERE status = 'open'"} ORDER BY id DESC`)
        .all() as SuggestionRow[]
    ).map(toSuggestion);

  let running: Promise<UpgradeRun> | undefined;
  const exports: UpgradesExports = {
    due(at = Date.now()) {
      if (!setting<boolean>("enabled")) return false;
      const last = (
        db.prepare(`SELECT started_at FROM ${T.runs} WHERE status != 'failed' ORDER BY id DESC LIMIT 1`).get() as
          | { started_at: string }
          | undefined
      )?.started_at;
      return !last || at - Date.parse(last) >= setting<number>("everyDays") * 0.93 * 86_400_000;
    },
    busy: () => running !== undefined,
    async run({ focus, requestedBy = "user" } = {}) {
      if (focus !== undefined && !FOCUSES.includes(focus))
        throw new UpgradeInvalid(`focus must be one of ${FOCUSES.join(", ")}`);
      if (running) throw new UpgradeInvalid("an upgrade is already running");
      const work = (async () => {
        const started = now();
        researchUsd = 0;
        const chosen = focus
          ? { focus, reason: requestedBy === "user" ? "Asked for by you." : `Asked for by ${requestedBy}.`, costUsd: 0 }
          : await chooseFocus();
        const id = Number(
          db
            .prepare(
              `INSERT INTO ${T.runs} (focus, reason, status, requested_by, started_at) VALUES (?, ?, 'running', ?, ?)`,
            )
            .run(chosen.focus, chosen.reason, requestedBy, started).lastInsertRowid,
        );
        context.log.info("upgrades.started", { id, focus: chosen.focus });
        let status: UpgradeRun["status"] = "done";
        let report: UpgradeReport;
        try {
          const { report: r } =
            chosen.focus === "ranking"
              ? await ranking(id)
              : chosen.focus === "embedder"
                ? await embedderRun(id)
                : await scout(id);
          report = { focus: chosen.focus, reason: chosen.reason, ...r };
        } catch (error) {
          status = "failed";
          report = {
            focus: chosen.focus,
            reason: chosen.reason,
            tried: [],
            result: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          };
          context.log.warn("upgrades.failed", { id, error: String(error) });
        }
        db.prepare(`UPDATE ${T.runs} SET status = ?, report_json = ?, cost_usd = ?, finished_at = ? WHERE id = ?`).run(
          status,
          JSON.stringify(report),
          spentSince(started) + researchUsd,
          now(),
          id,
        );
        rh.events.emit("upgrade.finished", { id, focus: chosen.focus, status });
        return toRun(db.prepare(`SELECT * FROM ${T.runs} WHERE id = ?`).get(id) as RunRow);
      })();
      running = work;
      try {
        return await work;
      } finally {
        running = undefined;
      }
    },
    runs(limit = 20) {
      return (db.prepare(`SELECT * FROM ${T.runs} ORDER BY id DESC LIMIT ?`).all(limit) as RunRow[]).map(toRun);
    },
    proposals(status) {
      return (
        db
          .prepare(`SELECT * FROM ${T.proposals} ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 50`)
          .all(...(status ? [status] : [])) as ProposalRow[]
      ).map(toProposal);
    },
    suggestions: suggestionsList,
    async approve(id) {
      const p = proposal(id);
      if (p.status !== "proposed") throw new UpgradeInvalid(`proposal ${id} is ${p.status}`);
      if (p.kind !== "embedder") throw new UpgradeInvalid(`proposal ${id} cannot be approved`);
      let dims = Number(p.payload.dims);
      if (!dims) {
        // A model without a size parameter: learn its native size from one embedding.
        const one = (await embedder()).createEmbedder({
          ledger: papers.embeddingLedger,
          model: String(p.payload.model),
          dims: 0,
        });
        dims = (await one.embed(["size probe"]))[0].length;
      }
      await host.configure("rh.embedder-openrouter", { model: p.payload.model, dims }, `proposal:upgrade-${p.runId}`);
      const commit = (await host.pluginHistory(1))[0]?.id ?? null;
      db.prepare(`UPDATE ${T.proposals} SET status = 'approved', commit_id = ?, decided_at = ? WHERE id = ?`).run(
        commit,
        now(),
        id,
      );
      return proposal(id);
    },
    reject(id) {
      const p = proposal(id);
      if (p.status !== "proposed") throw new UpgradeInvalid(`proposal ${id} is ${p.status}`);
      db.prepare(`UPDATE ${T.proposals} SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), id);
      return proposal(id);
    },
    dismiss(id) {
      const r = db.prepare(`UPDATE ${T.suggestions} SET status = 'dismissed' WHERE id = ?`).run(id);
      if (!r.changes) throw new UpgradeInvalid(`no suggestion ${id}`);
      return toSuggestion(db.prepare(`SELECT * FROM ${T.suggestions} WHERE id = ?`).get(id) as SuggestionRow);
    },
    chooseFocus,
  };

  // The weekly run starts after the nightly work when due; it finishes before the plugin stops.
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  rh.events.on("cycle.nightly", () => {
    if (stopped || running || !exports.due()) return;
    const work = exports
      .run({ requestedBy: "schedule" })
      .catch((error) => context.log.warn("upgrades.nightly_failed", { error: String(error) }));
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  context.subscriptions.push({
    dispose: async () => {
      stopped = true;
      await Promise.all(pending);
    },
  });
  return exports;
}
