// Spec slots: Kinds and topics (v1-3 task 1.1).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { RhError } from "@rh/sdk";
import { discover } from "../src/kernel/registry.ts";
import { startTestServer } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/plugins");

test("every built-in plugin is classified; core plugins are required; slot plugins name their slot", () => {
  const { plugins, invalid } = discover({});
  assert.deepEqual(invalid, []);
  const raw = [...plugins.values()];
  for (const p of raw) {
    assert.ok(["core", "slot", "addon", "preference"].includes(p.manifest.kind), p.manifest.id);
    if (p.manifest.kind === "core") assert.equal(p.manifest.required, true, `${p.manifest.id} is core, so required`);
    if (p.manifest.kind === "slot") assert.ok(p.manifest.slot, `${p.manifest.id} names its slot`);
  }
  const kinds = (k: string) =>
    raw
      .filter((p) => p.manifest.kind === k)
      .map((p) => p.manifest.id)
      .toSorted();
  assert.deepEqual(kinds("slot"), ["rh.embedder-openrouter", "rh.provider-openrouter"]);
  assert.deepEqual(kinds("preference"), ["rh.viewer-library", "rh.viewer-obsidian"]);
  assert.ok(kinds("addon").includes("rh.source-arxiv"));
  assert.ok(kinds("core").includes("rh.harness") && kinds("core").includes("rh.digest"));
});

test("a plugin claiming to be core is refused; installed plugins default to add-ons; the API reports kinds", async () => {
  const server = await startTestServer();
  try {
    const { client } = server;
    await assert.rejects(client.prepareInstall({ folder: join(FIXTURES, "acme.core") }), (e: unknown) => {
      assert.ok(e instanceof RhError);
      assert.deepEqual(e.details, ["kind: only the hub's own plugins are core"]);
      return true;
    });
    const installed = await client.approveInstall(
      (await client.prepareInstall({ folder: join(FIXTURES, "acme.needs-arxiv") })).planId,
    );
    assert.equal(installed.kind, "addon");
    const list = await client.plugins();
    assert.equal(list.plugins.find((p) => p.id === "rh.embedder-openrouter")?.slot, "embedder");
    assert.equal(list.plugins.find((p) => p.id === "rh.kb")?.kind, "core");
  } finally {
    await server.stop();
  }
});

test("the slot catalog lists each slot with its active implementation, alternatives and preset", async () => {
  const server = await startTestServer();
  try {
    const slots = await server.client.slots();
    assert.deepEqual(
      slots.map((s) => s.id),
      ["ranking", "embedder", "facets", "judge", "kb-search", "models"],
    );
    const embedder = slots.find((s) => s.id === "embedder")!;
    assert.equal(embedder.active.pluginId, "rh.embedder-openrouter");
    assert.match(embedder.active.name, /dimensions/);
    assert.equal(embedder.preset?.title, "SCIDOCS, LitSearch, your stars");
    assert.equal(embedder.last, null);
    assert.deepEqual(embedder.alternatives, []);
    assert.equal(slots.find((s) => s.id === "kb-search")!.preset, null);
    assert.equal(slots.find((s) => s.id === "ranking")!.active.detail?.cardsPerSweep, 7);
  } finally {
    await server.stop();
  }
});

test("each source is credited with the cards it brought and the ones you liked, in the API and the digest", async () => {
  const { validateCharter } = await import("../src/charter.ts");
  const { cardWriterRule } = await import("../src/faux-rules.ts");
  const { sampleCharter } = await import("./fixtures/charter.ts");
  const { choice, noul, score, scripted } = await import("./fixtures/jev-answers.ts");
  const { arxivOnlyFetch, fakePapers } = await import("./fixtures/sweep-env.ts");
  const { until } = await import("./helpers.ts");
  const server = await startTestServer({
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule],
      jevDecide: scripted((id: string, _c: string, q: any) =>
        id === "relevance"
          ? score(0.6, 5)
          : id === "matched_question"
            ? choice("Q1", Object.keys(q.criteria))
            : id === "kind"
              ? choice("survey", Object.keys(q.criteria))
              : id === "worth"
                ? noul(0.9)
                : undefined,
      ).decide,
      paperFetch: arxivOnlyFetch(fakePapers(8)),
    },
  });
  try {
    const p = server.hub.project;
    p.brief.write("# x");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    p.scheduler.trigger("sweep");
    await until(() => p.sweeps.list().length === 1, 10_000, "sweep");
    await p.sweeps.settled(p.sweeps.list(1)[0].id, 30_000);
    const cards = (await server.client.cards()).groups[0].cards;
    await server.client.judge(cards[0].id, "star");
    await server.client.judge(cards[1].id, "up");
    await server.client.judge(cards[2].id, "down");
    assert.deepEqual(await server.client.attribution(), [
      { source: "arxiv", pluginId: "rh.source-arxiv", cards: cards.length, liked: 2 },
    ]);
    const digest = await (
      await p.plugins.exportsOf<import("../plugins/rh.digest/main.ts").DigestExports>("rh.digest")
    ).buildDigest();
    assert.deepEqual(digest.sources, [{ source: "arxiv", pluginId: "rh.source-arxiv", cards: cards.length, liked: 2 }]);
  } finally {
    await server.stop();
  }
});
