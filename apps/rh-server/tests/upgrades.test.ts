// Spec weekly-upgrade: Weekly run, Focus choice, Ranking upgrade applied with undo, Embedder upgrade proposed, Add-on
// scouting, Reports and proposals (v1-4 tasks 2.1–2.4), offline with scripted Jev and a fake OpenRouter.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessExports } from "../plugins/rh.harness/main.ts";
import { jsonArray, plainReason, type UpgradesExports } from "../plugins/rh.upgrades/main.ts";
import { rankingGrid, shiftWeights } from "../plugins/rh.upgrades/ranking.ts";
import { DEFAULT_SETTINGS } from "../src/harness/replay.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, deskToolRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { choice, noul, score, scripted } from "./fixtures/jev-answers.ts";
import { fakeOpenRouter } from "./fixtures/openrouter.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./test-server.ts";

const MODELS = [
  { id: "acme/embed-small", prompt: "0.00000002", created: 1_780_000_000, dimensions: true },
  { id: "acme/embed-native", prompt: "0.00000001", created: 1_790_000_000 },
  { id: "acme/embed-pricey", prompt: "0.000001", created: 1_795_000_000, dimensions: true },
];

/** A project with `sweeps` sweeps of 12 papers: the user likes the "Good" ones, which Jev scores as more relevant. */
async function project(options: { sweeps?: number; focus?: [string, number] } = {}) {
  let batch = 0;
  const batches = Array.from({ length: options.sweeps ?? 0 }, (_, b) =>
    fakePapers(12, "x").map((p, i) => ({
      ...p,
      id: `26${30 + b}.${50000 + i}`,
      title: `${i % 3 ? "Bad" : "Good"} paper ${b}-${i} on protein language models`,
    })),
  );
  const jev = scripted((id, _c, question: any, state: any) => {
    const title = String(state.paper?.title ?? "");
    if (id === "focus" && options.focus)
      return choice(options.focus[0], Object.keys(question.criteria), options.focus[1]);
    if (id === "relevance") return score(title.startsWith("Good") ? 1 : 0.5, 5);
    if (id === "matched_question") return choice("Q1", Object.keys(question.criteria));
    if (id === "kind") return choice("survey", Object.keys(question.criteria));
    if (id === "worth") return noul(0.9);
    if (id === "like") return noul(0.5);
    return undefined;
  });
  const or = fakeOpenRouter(MODELS);
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule, deskToolRule],
      jevDecide: jev.decide,
      paperFetch: ((i: any, init: any) =>
        String(i instanceof Request ? i.url : i).startsWith("https://openrouter.ai")
          ? or.fetch(i, init)
          : arxivOnlyFetch(batches[batch] ?? [])(i, init)) as typeof fetch,
    },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# x");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  await projectRuntime.plugins.kernel.configure("rh.sweep", { cardsPerSweep: 12, explorationPicks: 0 });
  for (let b = 0; b < batches.length; b++) {
    batch = b;
    projectRuntime.scheduler.trigger("sweep");
    await until(() => projectRuntime.sweeps.list().length === b + 1, 10_000, "sweep");
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
  }
  for (const group of (await server.client.cards(200)).groups)
    for (const card of group.cards)
      await server.client.judge(
        card.id,
        card.paper.title.startsWith("Good") ? "up" : "down",
        card.paper.title.startsWith("Good") ? undefined : "off topic",
      );
  const upgrades = await projectRuntime.plugins.exportsOf<UpgradesExports>("rh.upgrades");
  const harness = await projectRuntime.plugins.exportsOf<HarnessExports>("rh.harness");
  return { server, p: projectRuntime, upgrades, harness, or, jev };
}

test("the grid starts from what the analysis points at and keeps rank weights summing to the same total", () => {
  const shifted = shiftWeights(DEFAULT_SETTINGS.rankWeights, "relevance");
  const sum = (x: object) => Object.values(x).reduce((a: number, b) => a + (b as number), 0);
  assert.ok(Math.abs(sum(shifted) - sum(DEFAULT_SETTINGS.rankWeights)) < 0.02);
  assert.ok(shifted.relevance > DEFAULT_SETTINGS.rankWeights.relevance);
  const grid = rankingGrid(DEFAULT_SETTINGS, {
    judged: 30,
    disliked: { "off-topic": 9 },
    likedRankedLow: 0,
    explorationLiked: 0,
    explorationDisliked: 0,
    unjudgedShare: 0,
  });
  assert.ok(grid.length <= 12);
  assert.deepEqual(grid[0].variant, { relevanceMin: DEFAULT_SETTINGS.relevanceMin + 0.05 });
  assert.deepEqual(jsonArray('Sure: ```json\n[{"id": "a"}]\n```'), [{ id: "a" }]);
  assert.deepEqual(jsonArray("no idea"), []);
  assert.equal(
    plainReason("Free DOI metadata, no key needed [crossref.org](https://api.crossref.org/works)."),
    "Free DOI metadata, no key needed.",
  );
});

test("due after everyDays; Jev picks the focus, and below 0.4 confidence the rotation does", async () => {
  const env = await project({ focus: ["embedder", 0.8] });
  try {
    assert.equal(env.upgrades.due(), true, "never ran");
    const chosen = await env.upgrades.chooseFocus();
    assert.equal(chosen.focus, "embedder");
    assert.match(chosen.reason, /Jev \(confidence 0\.80\)/);
    const run = await env.upgrades.run({ focus: "scout-addons" });
    assert.equal(run.focus, "scout-addons");
    assert.equal(env.upgrades.due(), false);
    assert.equal(env.upgrades.due(Date.now() + 7 * 86_400_000), true);
    await env.p.plugins.kernel.configure("rh.upgrades", { enabled: false });
    assert.equal(env.upgrades.due(Date.now() + 70 * 86_400_000), false);
  } finally {
    await env.server.stop();
  }
  const unsure = await project({ focus: ["ranking", 0.2] });
  try {
    await unsure.upgrades.run({ focus: "ranking" });
    const chosen = await unsure.upgrades.chooseFocus();
    assert.equal(chosen.focus, "embedder", "the next after ranking");
    assert.match(chosen.reason, /rotation/);
  } finally {
    await unsure.server.stop();
  }
});

test("a ranking run replays variants and applies the best better one with undo, or changes nothing", async () => {
  const env = await project({ sweeps: 5 });
  try {
    // The defaults already put the liked (more relevant) papers first: nothing is better, nothing changes.
    const before = env.p.plugins.kernel.settings("rh.sweep");
    const first = await env.upgrades.run({ focus: "ranking" });
    assert.equal(first.status, "done");
    assert.ok(first.report!.tried.length >= 1 && first.report!.tried.length <= 12);
    assert.ok(
      first.report!.tried.every((t) => t.verdict),
      "every variant has a verdict",
    );
    assert.match(first.report!.result, /^Nothing changed: no variant replayed as better/);
    assert.deepEqual(env.p.plugins.kernel.settings("rh.sweep"), before);
    assert.equal(env.upgrades.proposals().length, 0);

    // Settings that ignore relevance: moving weight back to relevance replays as better and is applied, undoably.
    await env.p.plugins.kernel.configure("rh.sweep", {
      cardsPerSweep: 4,
      rankWeights: { importance: 0.5, relevance: 0, question: 0.25, level: 0.25, freshness: 0 },
    });
    const poor = env.p.plugins.kernel.settings("rh.sweep");
    const second = await env.upgrades.run({ focus: "ranking" });
    const [applied] = env.upgrades.proposals("applied");
    assert.ok(applied, second.report!.result);
    assert.match(second.report!.result, /^Applied/);
    assert.equal(applied.runId, second.id);
    assert.notDeepEqual(env.p.plugins.kernel.settings("rh.sweep"), poor);
    const [change] = await env.server.client.pluginHistory();
    assert.equal(change.actor, `proposal:upgrade-${second.id}`);
    await env.p.plugins.kernel.undo(applied.commit!, "user");
    assert.deepEqual(env.p.plugins.kernel.settings("rh.sweep"), poor);
    assert.equal(env.upgrades.runs()[0].id, second.id);
  } finally {
    await env.server.stop();
  }
  const empty = await project();
  try {
    const run = await empty.upgrades.run({ focus: "ranking" });
    assert.match(run.report!.result, /Nothing changed: not enough data/);
    assert.equal(empty.upgrades.proposals().length, 0);
  } finally {
    await empty.server.stop();
  }
});

test("an embedder run shortlists from the cheap catalog, benchmarks, and proposes a clear winner for approval", async () => {
  const env = await project();
  try {
    env.or.answer =
      'I found: [{"id": "acme/embed-native", "reason": "tops SciDocs"}, {"id": "acme/embed-pricey", "reason": "x"}, {"id": "made/up"}]';
    const real = env.harness.runBenchmark;
    const value = (c: Record<string, unknown>) => (c.model === "acme/embed-native" ? 0.7 : 0.6);
    env.harness.runBenchmark = async (slot, candidate = {}) => {
      const tasks = ["scidocs", "litsearch", "your-stars"].map((task) => ({
        task,
        metric: "nDCG@10",
        value: value(candidate),
        items: 10,
      }));
      return {
        id: 1,
        slot,
        preset: slot,
        candidate: { model: candidate.model ?? "active", dims: candidate.dims ?? 384 },
        result: { tasks, value: value(candidate), label: "" },
        costUsd: 0.01,
        createdAt: new Date().toISOString(),
      };
    };
    const run = await env.upgrades.run({ focus: "embedder" });
    env.harness.runBenchmark = real;
    const report = run.report!;
    assert.equal(report.tried.length, 2, "the active model and the one shortlisted model within the price limit");
    assert.match(report.tried[1].what, /acme\/embed-native/);
    assert.equal(report.tried[1].verdict, "better");
    assert.equal(env.or.research.length, 1);
    assert.doesNotMatch(JSON.stringify(env.or.research[0]), /embed-pricey/, "over the price limit, never offered");
    const [proposal] = env.upgrades.proposals("proposed");
    assert.equal(proposal.payload.model, "acme/embed-native");
    assert.equal(proposal.payload.dims, 0, "no dimensions parameter: its native size");

    const approved = await env.upgrades.approve(proposal.id);
    assert.equal(approved.status, "approved");
    const settings = env.p.plugins.kernel.settings("rh.embedder-openrouter");
    assert.equal(settings.model, "acme/embed-native");
    assert.equal(settings.dims, 256, "the offline embedder's native size");
    await assert.rejects(env.upgrades.approve(proposal.id), /is approved/);
    await env.p.plugins.kernel.undo(approved.commit!, "user");
    assert.notEqual(env.p.plugins.kernel.settings("rh.embedder-openrouter").model, "acme/embed-native");

    // Without research the newest cheap models are tried; no winner, nothing proposed.
    env.or.answer = "nothing useful";
    const run2 = await env.upgrades.run({ focus: "embedder" });
    assert.match(run2.report!.result, /^Nothing changed/);
    assert.equal(env.upgrades.proposals("proposed").length, 0);
    // What lost is remembered: the next run has no untried model within the price limit.
    const run3 = await env.upgrades.run({ focus: "embedder" });
    assert.match(run3.report!.result, /not tried in the last 90 days/);
    const p2 = env.upgrades.proposals()[0];
    assert.throws(() => env.upgrades.reject(p2.id), /is approved/);
  } finally {
    await env.server.stop();
  }
});

test("a scout run lists new sources from the web that the user can dismiss", async () => {
  const env = await project();
  try {
    env.or.answer = JSON.stringify([
      { name: "bioRxiv API", url: "https://api.biorxiv.org", reason: "biology preprints" },
      { name: "arxiv", url: "https://arxiv.org", reason: "already there" },
      { name: "No link", url: "ftp://x", reason: "bad url" },
    ]);
    const run = await env.upgrades.run({ focus: "scout-addons" });
    assert.match(run.report!.result, /1 add-on suggestion/);
    assert.equal(run.costUsd, 0.02, "the web search's cost");
    const [suggestion] = env.upgrades.suggestions();
    assert.equal(suggestion.name, "bioRxiv API");
    assert.match(String(env.or.research[0].messages.at(-1).content), /arxiv/);
    env.upgrades.dismiss(suggestion.id);
    assert.equal(env.upgrades.suggestions().length, 0);
    assert.equal(env.upgrades.suggestions(true).length, 1);
  } finally {
    await env.server.stop();
  }
});

test("the API starts a run in the background, lists it, decides proposals and dismisses suggestions; the digest shows it", async () => {
  const env = await project();
  try {
    const { client } = env.server;
    const empty = await client.upgrades();
    assert.equal(empty.enabled, true);
    assert.equal(empty.due, true);
    assert.deepEqual(empty.runs, []);
    await assert.rejects(client.runUpgrade("everything" as never), /focus must be one of/);

    env.or.answer = '[{"name": "bioRxiv API", "url": "https://api.biorxiv.org", "reason": "biology preprints"}]';
    assert.deepEqual(await client.runUpgrade("scout-addons"), { started: true });
    await until(async () => (await client.upgrades()).runs[0]?.status === "done", 10_000, "run");
    const view = await client.upgrades();
    assert.equal(view.running, false);
    assert.equal(view.due, false);
    assert.equal(view.runs[0].focus, "scout-addons");
    assert.equal(view.suggestions[0].name, "bioRxiv API");
    assert.equal((await client.dismissSuggestion(view.suggestions[0].id)).status, "dismissed");
    assert.deepEqual((await client.upgrades()).suggestions, []);
    await assert.rejects(client.dismissSuggestion(999), /no suggestion 999/);
    await assert.rejects(client.approveProposal(999), /no proposal 999/);
    await assert.rejects(client.rejectProposal(999), /no proposal 999/);

    const digest = await env.server.hub.project.plugins
      .exportsOf<import("../plugins/rh.digest/main.ts").DigestExports>("rh.digest")
      .then((d) => d.buildDigest(Date.now() + 1000));
    assert.equal(digest.upgrade?.runs.length, 1);
    assert.equal(digest.upgrade?.runs[0].focus, "scout-addons");
    assert.match(digest.upgrade?.runs[0].result ?? "", /1 add-on suggestion/);
    await client.commentDigest(digest.id, "upgrade", "Nice find");
  } finally {
    await env.server.stop();
  }
});
