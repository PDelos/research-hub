// The weekly upgrade's embedder procedure (spec weekly-upgrade: Embedder upgrade proposed; design v1-4 D4): cheap
// catalog models not tried lately, a shortlist of two (web research, else the newest), the embedder preset on the
// active model and each candidate within the run's cost cap, and a proposal for a clear winner.
import type { BenchmarkRecord, HarnessExports } from "../rh.harness/main.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";
import type { CatalogModel, UpgradeReport } from "./main.ts";
import { jsonArray, plainReason } from "./model-answers.ts";

/** Tokens one embedder benchmark embeds (the two samples and "your stars"), for the cost estimate. */
export const BENCHMARK_TOKENS_MILLIONS = 1.2;
export const WIN_MARGIN = 0.02;
const DAY_MS = 86_400_000;
/** Candidates benchmarked this recently lost to the active model: not tried again. */
const LOST_MEMORY_DAYS = 90;
/** The active model's result is reused while it is this fresh. */
const BASELINE_FRESH_DAYS = 30;

type Pick = { id: string; reason: string };
type Outcome = { report: Omit<UpgradeReport, "focus" | "reason"> };

export interface EmbedderUpgradeDeps {
  harness: HarnessExports;
  research: ProviderExports["research"];
  active: { model: string; dims: number };
  catalog: CatalogModel[];
  maxPricePerMillion: number;
  maxRunUsd: number;
  /** What the run's web research has cost so far. */
  researchUsd(): number;
  propose(payload: Record<string, unknown>): { id: number };
}

function modelsTriedLately(harness: HarnessExports): Set<string> {
  const since = new Date(Date.now() - LOST_MEMORY_DAYS * DAY_MS).toISOString();
  const recent = harness.benchmarks("embedder", 200).filter((b) => b.candidate.candidate && b.createdAt >= since);
  return new Set(recent.map((b) => String(b.candidate.model)));
}

async function shortlistByResearch(deps: EmbedderUpgradeDeps, eligible: CatalogModel[]) {
  const candidates = eligible.map((m) => `- ${m.id} ($${m.pricePerMillion.toFixed(3)}/M tokens): ${m.description}`);
  try {
    const answer = await deps.research(
      `Which of these OpenRouter embedding models is likely best for retrieving scientific papers (biology, bioinformatics, machine learning) by title and abstract? Search the web for recent benchmark results (e.g. MTEB, SciDocs). Answer only with a JSON array of at most 2 objects {"id": "<one of the ids>", "reason": "<one sentence>"}, best first.\n\nCurrent model: ${deps.active.model}\nCandidates:\n${candidates.join("\n")}`,
      { maxResults: 5 },
    );
    const ids = new Set(eligible.map((m) => m.id));
    const shortlist: Pick[] = jsonArray(answer.text)
      .filter((item): item is { id: string; reason?: string } => typeof (item as { id?: unknown })?.id === "string")
      .filter((item) => ids.has(item.id))
      .slice(0, 2)
      .map((item) => ({ id: item.id, reason: plainReason(item.reason) }));
    return {
      shortlist,
      note: shortlist.length ? "shortlisted by web research" : "web research named no catalog model",
    };
  } catch (error) {
    return {
      shortlist: [],
      note: `web research unavailable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

const newestTwo = (eligible: CatalogModel[]): Pick[] =>
  eligible
    .toSorted((a, b) => b.created - a.created)
    .slice(0, 2)
    .map((m) => ({ id: m.id, reason: "one of the newest models within the price limit" }));

/** The active model's numbers: a result younger than 30 days, else a new run. */
async function baseline(harness: HarnessExports, active: EmbedderUpgradeDeps["active"]) {
  const last = harness
    .benchmarks("embedder", 20)
    .find((b) => b.candidate.model === active.model && b.candidate.dims === active.dims);
  const isFresh = !!last && Date.now() - Date.parse(last.createdAt) < BASELINE_FRESH_DAYS * DAY_MS;
  return { record: isFresh ? last : await harness.runBenchmark("embedder"), isFresh };
}

const numbersOf = (r: BenchmarkRecord) =>
  Object.fromEntries([...r.result.tasks.map((t) => [t.task, t.value] as const), ["mean", r.result.value] as const]);
const yourStars = (r: BenchmarkRecord) => r.result.tasks.find((t) => t.task === "your-stars")?.value ?? null;

/** Better by the margin on the mean, and not worse on the user's own stars (when both have them). */
function beats(candidate: BenchmarkRecord, active: BenchmarkRecord): boolean {
  if (candidate.result.value === null || active.result.value === null) return false;
  const candidateStars = yourStars(candidate);
  const activeStars = yourStars(active);
  const starsOk = candidateStars === null || activeStars === null || candidateStars >= activeStars;
  return candidate.result.value - active.result.value >= WIN_MARGIN && starsOk;
}

interface Winner {
  model: string;
  dims: number;
  record: BenchmarkRecord;
  reason: string;
}

async function benchmarkShortlist(
  deps: EmbedderUpgradeDeps,
  shortlist: Pick[],
  eligible: CatalogModel[],
  base: BenchmarkRecord,
) {
  const tried: UpgradeReport["tried"] = [];
  let winner: Winner | undefined;
  let spent = base.costUsd + deps.researchUsd();
  for (const pick of shortlist) {
    const model = eligible.find((e) => e.id === pick.id)!;
    const estimate = BENCHMARK_TOKENS_MILLIONS * model.pricePerMillion;
    if (spent + estimate > deps.maxRunUsd) {
      tried.push({
        what: model.id,
        why: pick.reason,
        note: `skipped: about $${estimate.toFixed(2)} would pass the run's $${deps.maxRunUsd} cap`,
      });
      continue;
    }
    // Same size as the active model when the model lets us choose, else its own.
    const dims = model.dimensionsParam ? deps.active.dims : 0;
    try {
      const run = await deps.harness.runBenchmark("embedder", { model: model.id, ...(dims ? { dims } : {}) });
      spent += run.costUsd;
      const wins = beats(run, base);
      tried.push({
        what: `${model.id} (${run.candidate.dims} dimensions)`,
        why: pick.reason,
        verdict: wins ? "better" : "not better",
        numbers: numbersOf(run),
      });
      if (wins && (!winner || (run.result.value ?? 0) > (winner.record.result.value ?? 0)))
        winner = { model: model.id, dims, record: run, reason: pick.reason };
    } catch (error) {
      tried.push({
        what: model.id,
        why: pick.reason,
        note: `failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { tried, winner };
}

export async function embedderUpgrade(deps: EmbedderUpgradeDeps): Promise<Outcome> {
  const { active, catalog, maxPricePerMillion } = deps;
  const triedBefore = modelsTriedLately(deps.harness);
  const eligible = catalog.filter(
    (m) =>
      m.id !== active.model &&
      !triedBefore.has(m.id) &&
      m.pricePerMillion <= maxPricePerMillion &&
      m.contextLength >= 512,
  );
  const analysis = {
    catalog: catalog.length,
    eligible: eligible.length,
    triedBefore: [...triedBefore],
    maxPricePerMillion,
    active,
  };
  if (!eligible.length)
    return {
      report: {
        analysis,
        tried: [],
        result: "Nothing changed: no embedding model within the price limit that was not tried in the last 90 days.",
      },
    };
  const researched = await shortlistByResearch(deps, eligible);
  const shortlist = researched.shortlist.length ? researched.shortlist : newestTwo(eligible);
  const base = await baseline(deps.harness, active);
  const activeLine = {
    what: `${active.model} (active, ${active.dims} dimensions)`,
    numbers: numbersOf(base.record),
    note: base.isFresh ? "earlier result" : undefined,
  };
  const { tried, winner } = await benchmarkShortlist(deps, shortlist, eligible, base.record);
  const reportAnalysis = { ...analysis, research: researched.note };
  if (!winner)
    return {
      report: {
        analysis: reportAnalysis,
        tried: [activeLine, ...tried],
        result: "Nothing changed: no candidate beat the active model by 0.02 nDCG@10 without losing on your stars.",
      },
    };
  const proposal = deps.propose({
    model: winner.model,
    dims: winner.dims,
    reason: winner.reason,
    mean: winner.record.result.value,
    activeMean: base.record.result.value,
    activeModel: active.model,
    activeDims: active.dims,
  });
  const mean = (winner.record.result.value ?? 0).toFixed(3);
  return {
    report: {
      analysis: reportAnalysis,
      tried: [activeLine, ...tried],
      result: `Proposed ${winner.model} (${winner.dims || "native"} dimensions): mean nDCG@10 ${mean} vs ${(base.record.result.value ?? 0).toFixed(3)}. Approve it in the Upgrades tab (proposal ${proposal.id}); the papers are then re-embedded in the background.`,
    },
  };
}
