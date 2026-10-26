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
