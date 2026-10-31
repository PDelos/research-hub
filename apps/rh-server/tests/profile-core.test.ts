// The core profile at work (spec feature-profiles: Feature off is not an error, Advanced features switches; daily-cycle
// in core): routes of disabled features answer feature_off, the nightly run and the digest work without them, and
// each advanced feature comes back live when switched on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRhError } from "@rh/sdk";
import type { DigestExports } from "../plugins/rh.digest/main.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { byId, noul, pick, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { ADVANCED } from "./fixtures/profile.ts";
import { startTestServer, until, type TestServer } from "./test-server.ts";

const passAll = byId({
  relevance: score(0.5, 5),
  matched_question: pick("Q1"),
  kind: pick("survey"),
  worth: noul(0.9),
});

const core = () =>
  startTestServer({
    env: { RH_PROFILE: "core" },
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule],
      jevDecide: scripted(passAll).decide,
      paperFetch: arxivOnlyFetch(fakePapers(6)),
    },
  });

const approveCharter = (server: TestServer) => {
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# Protein LMs");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
};

/** The error a call ends in, or undefined when it succeeds. */
const failureOf = async (call: Promise<unknown>) => {
  try {
    await call;
    return undefined;
  } catch (error) {
    return error;
  }
};

test("in core, /v1/info reports the profile, plugins carry `advanced`, and disabled features answer feature_off", async () => {
  const server = await core();
  try {
    const info = await server.client.info();
    assert.equal(info.profile, "core");
    const { plugins } = await server.client.plugins();
    assert.deepEqual(
      plugins
        .filter((p) => p.advanced)
        .map((p) => p.id)
        .toSorted(),
      ADVANCED,
    );
    for (const [call, plugin] of [
      [server.client.upgrades(), "rh.upgrades"],
      [server.client.quality(), "rh.harness"],
      [server.client.knowledge(), "rh.knowledge"],
      [server.client.ideas(), "rh.engineer"],
    ] as const) {
      const error = await failureOf(call);
      assert.ok(isRhError(error), plugin);
      assert.equal(error.code, "feature_off", plugin);
      assert.equal(error.status, 409, plugin);
      assert.deepEqual(error.details, { plugin }, plugin);
    }
  } finally {
    await server.stop();
  }
});

test("in core, the nightly run and the digest work; the digest has no quality, sources, upgrade or charter", async () => {
  const server = await core();
  approveCharter(server);
  const projectRuntime = server.hub.project;
  try {
    for (const kind of ["sweep", "nightly"] as const) projectRuntime.scheduler.trigger(kind);
    await until(
      () => projectRuntime.scheduler.runs(10).filter((r) => r.status === "done").length === 2,
      30_000,
      "sweep and nightly done",
    );
    const digest = await (await projectRuntime.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    assert.ok(digest.cycle.sweeps.length >= 1);
    assert.ok(digest.cycle.nightlyRuns >= 1);
    for (const section of ["quality", "sources", "upgrade", "charter"] as const)
      assert.equal(digest[section], undefined, section);
    assert.ok(!projectRuntime.scheduler.runs(10).some((r) => r.status === "failed"));
    assert.ok(!server.logs.some((l) => /knowledge_review_failed|night_failed|nightly_failed/.test(l)));
  } finally {
    await server.stop();
  }
});

test("each advanced feature comes back live when switched on, without a restart", async () => {
  const server = await core();
  const { client } = server;
  const { contributions } = server.hub.project.plugins;
  const points = async (point: string) =>
    (await contributions.contributionsTo(point, { activate: true })).map((c) => c.id);
  try {
    await client.setPluginEnabled("rh.harness", true);
    assert.ok(await client.quality());
    await client.setPluginEnabled("rh.knowledge", true);
    assert.ok(await client.knowledge());
    // The weekly upgrade and the engineer need the harness, which is on now.
    await client.setPluginEnabled("rh.upgrades", true);
    assert.ok(await client.upgrades());
    await client.setPluginEnabled("rh.engineer", true);
    assert.deepEqual(await client.ideas(), []);
    // The finders contribute to the knowledge review's extension point.
    for (const id of ["rh.finder-method-transfer", "rh.finder-missing-links", "rh.finder-rising-topics"])
      await client.setPluginEnabled(id, true);
    assert.deepEqual((await points("knowledge.finder")).toSorted(), [
      "method-transfer",
      "missing-links",
      "rising-topics",
    ]);
    // Docling joins the converter slot and the local embedder the embedder slot (each says why it cannot run here).
    await client.setPluginEnabled("rh.converter-docling", true);
    assert.ok((await client.converters()).some((c) => c.id === "docling"));
    await client.setPluginEnabled("rh.embedder-local", true);
    assert.ok((await points("papers.embedder")).includes("local"));
    const states = new Map((await client.plugins()).plugins.map((p) => [p.id, p.state]));
    for (const id of ADVANCED) assert.notEqual(states.get(id), "disabled", id);
  } finally {
    await server.stop();
  }
});

test("in core the digest lists open rule candidates under the judgments, grouped by reason; with the knowledge review on, it does not", async () => {
  const server = await core();
  approveCharter(server);
  const projectRuntime = server.hub.project;
  try {
    projectRuntime.scheduler.trigger("sweep");
    await until(() => projectRuntime.sweeps.list(1).length === 1, 10_000, "sweep");
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
    const cards = (await server.client.cards()).groups[0].cards;
    assert.ok(cards.length >= 4);
    const candidate = projectRuntime.db.prepare(
      "INSERT INTO rule_candidates (card_id, reason, reason_kind, probability, status, created_at) VALUES (?, ?, 'off-topic', 0.9, ?, ?)",
    );
    const now = new Date().toISOString();
    candidate.run(cards[0].id, "No clinical trials", "open", now);
    candidate.run(cards[1].id, "  no clinical   TRIALS ", "open", now);
    candidate.run(cards[2].id, "Too basic for me", "open", now);
    candidate.run(cards[3].id, "Already a rule", "accepted", now);

    const digest = await (await projectRuntime.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    const listed = digest.judgments.ruleCandidates ?? [];
    assert.deepEqual(
      listed.map((r) => [r.reason, r.count, r.cards.map((c) => c.cardId).toSorted((a, b) => a - b)]),
      [
        ["no clinical TRIALS", 2, [cards[0].id, cards[1].id].toSorted((a, b) => a - b)],
        ["Too basic for me", 1, [cards[2].id]],
      ],
    );
    assert.ok(listed[0].cards.every((c) => c.title.length > 0));

    // The knowledge review on: today's digest (its Charter section), without the read-only list.
    await server.client.setPluginEnabled("rh.knowledge", true);
    const withReview = await (await projectRuntime.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    assert.equal(withReview.judgments.ruleCandidates, undefined);
    assert.ok(withReview.charter);
  } finally {
    await server.stop();
  }
});
