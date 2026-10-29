// Spec daily-cycle: One orchestrated daily cycle, Cycle status, Weekly digest, Comments on the digest (task 5.2):
// a simulated offline week with no user action, then the digest and a comment carried into the next one.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DigestExports } from "../plugins/rh.digest/main.ts";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { byId, noul, pick, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, until } from "./test-server.ts";

const passAll = byId({
  relevance: score(0.5, 5),
  matched_question: pick("Q1"),
  kind: pick("survey"),
  worth: noul(0.9),
});
const at = (iso: string) => Date.parse(iso);
const days = ["19", "20", "21", "22", "23", "24", "25"]; // Mon 2026-10-19 … Sun 2026-10-25 (ISO week 43)

test("a simulated week runs 7 sweeps, 7 nightly runs and 1 digest, each once, with no user action", async () => {
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule],
      jevDecide: scripted(passAll).decide,
      paperFetch: arxivOnlyFetch(fakePapers(10)),
    },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# Protein LMs");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  const scheduler = projectRuntime.scheduler;
  const runs = () => scheduler.runs(500);
  const settled = async (slot: string) => {
    await until(
      () => runs().some((r) => r.slot === slot && ["done", "failed", "skipped"].includes(r.status)),
      30_000,
      slot,
    );
    const sweep = projectRuntime.sweeps.list(1)[0];
    if (slot.startsWith("sweep:") && sweep) await projectRuntime.sweeps.settled(sweep.id, 30_000);
  };
  try {
    // Day 0 (Sunday the 18th, evening): the cycle starts; its earlier slots are not part of the week.
    scheduler.tick(at("2026-10-18T07:00:30Z"));
    for (const slot of ["sweep:2026-10-18", "nightly:2026-10-18", "review:2026-W42"]) await settled(slot);

    for (const d of days) {
      for (const [time, slot] of [
        ["02:00:30", `nightly:2026-10-${d}`],
        ["06:00:30", `sweep:2026-10-${d}`],
      ] as const) {
        scheduler.tick(at(`2026-10-${d}T${time}Z`));
        scheduler.tick(at(`2026-10-${d}T${time.replace(":30", ":50")}Z`)); // a second tick inside the slot changes nothing
        await settled(slot);
      }
      if (d === "25") {
        scheduler.tick(at("2026-10-25T07:00:30Z"));
        await settled("review:2026-W43");
      }
    }

    const week = runs().filter(
      (r) => days.some((d) => r.slot.endsWith(`2026-10-${d}`)) || r.slot === "review:2026-W43",
    );
    const byKind = (k: string) => week.filter((r) => r.kind === k);
    assert.equal(byKind("sweep").length, 7);
    assert.equal(byKind("nightly").length, 7);
    assert.equal(byKind("review").length, 1);
    assert.ok(byKind("nightly").every((r) => r.status === "done"));
    assert.equal(byKind("review")[0].status, "done");
    assert.equal(new Set(week.map((r) => r.slot)).size, week.length, "each slot once");

    // The digest of week 43 covers the week's sweeps and nights and lists them.
    const digests = await server.client.digests();
    const w43 = digests.find((d) => d.week === "2026-W43")!;
    const digest = await server.client.digest(w43.id);
    const weekSweeps = projectRuntime.sweeps
      .list(50)
      .filter((sw) => week.some((r) => r.kind === "sweep" && r.id === sw.scheduledRunId));
    assert.equal(weekSweeps.length, 7);
    for (const sw of weekSweeps)
      assert.ok(
        digest.cycle.sweeps.some((x) => x.id === sw.id),
        `sweep ${sw.id} in the digest`,
      );
    assert.ok(digest.cycle.nightlyRuns >= 7);
    // Nothing was judged, so every card of the digest's sweeps is waiting.
    assert.equal(digest.judgments.total, 0);
    assert.equal(
      digest.judgments.waiting,
      digest.cycle.sweeps.reduce((n, x) => n + x.cards, 0),
    );
    assert.equal(digest.cost.modelUsd + digest.cost.jevUsd + digest.cost.embeddingUsd, digest.cost.totalUsd);

    // The cycle status.
    const cycle = await server.client.cycle();
    assert.equal(cycle.lastDigest?.week, "2026-W43");
    assert.ok(cycle.lastNightly);
    assert.ok(cycle.next.nightly && cycle.next.review);

    // A comment is stored and shown in the next digest; it is also an event for later plugins.
    const events: unknown[] = [];
    projectRuntime.plugins.services.events.on("digest.comment", (e) => void events.push(e));
    await server.client.commentDigest(w43.id, "judgments", "too many reviews, more methods papers");
    await assert.rejects(server.client.commentDigest(w43.id, "nonsense" as never, "x"), /section must be one of/);
    await assert.rejects(server.client.commentDigest(9999, "general", "x"), /No digest 9999/);
    assert.equal(events.length, 1);
    const next = await (await projectRuntime.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    assert.deepEqual(
      next.lastComments.map((c) => [c.section, c.text]),
      [["judgments", "too many reviews, more methods papers"]],
    );
  } finally {
    await server.stop();
  }
});

test("the digest lists the week's judgments, precision, knowledge-base notes and changes, at no model cost", async () => {
  const { librarianRule } = await import("../src/faux-rules.ts");
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule, librarianRule],
      jevDecide: scripted(passAll).decide,
      paperFetch: arxivOnlyFetch(fakePapers(10)),
    },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# Protein LMs");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  projectRuntime.syncVault();
  try {
    projectRuntime.scheduler.trigger("sweep");
    await until(() => projectRuntime.sweeps.list(1).length === 1, 10_000, "sweep");
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list(1)[0].id, 30_000);
    const cards = (await server.client.cards()).groups[0].cards;
    await server.client.judge(cards[0].id, "star", "foundational");
    await server.client.judge(cards[1].id, "up");
    await server.client.judge(cards[2].id, "down", "off topic");
    await until(async () => (await server.client.kbPapers()).some((k) => k.status === "done"), 30_000, "note written");
    await server.client.setPluginEnabled("rh.source-europepmc", false);

    const digest = await (await projectRuntime.plugins.exportsOf<DigestExports>("rh.digest")).buildDigest();
    assert.deepEqual(
      [digest.judgments.star, digest.judgments.up, digest.judgments.down, digest.judgments.total],
      [1, 1, 1, 3],
    );
    assert.equal(digest.judgments.waiting, cards.length - 3);
    assert.equal(digest.judgments.precision.length, 1);
    assert.equal(digest.judgments.precision[0].judged, 3);
    assert.equal(digest.knowledgeBase.added.length, 1);
    assert.ok(digest.changes.some((c) => c.message === "disable rh.source-europepmc" && c.actor === "user"));
    assert.equal(digest.cycle.sweeps.length, 1);
    // Building the digest made no model call.
    const generations = projectRuntime.db
      .prepare("SELECT COUNT(*) n FROM generations WHERE started_at >= ?")
      .get(Date.parse(digest.to)) as {
      n: number;
    };
    assert.equal(Number(generations.n), 0);
  } finally {
    await server.stop();
  }
});
