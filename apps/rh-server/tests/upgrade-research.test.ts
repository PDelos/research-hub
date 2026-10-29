// Spec weekly-upgrade (v1-4 task 1.2): research is a web-search completion through OpenRouter's web plugin.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ResearchUnavailable, type ProviderExports } from "../plugins/rh.provider-openrouter/main.ts";
import { fakeOpenRouter } from "./fixtures/openrouter.ts";
import { startTestServer } from "./helpers.ts";

test("research asks OpenRouter with the web plugin and returns the answer, its sources and cost", async () => {
  const or = fakeOpenRouter([]);
  or.answer = "Use model X.";
  const server = await startTestServer({ hub: { paperFetch: or.fetch } });
  try {
    const provider = await server.hub.project.plugins.exportsOf<ProviderExports>("rh.provider-openrouter");
    const researchResult = await provider.research("Which embedding model?", { system: "Be brief.", maxResults: 3 });
    assert.equal(researchResult.text, "Use model X.");
    assert.deepEqual(researchResult.citations, [{ url: "https://example.org/leaderboard", title: "A leaderboard" }]);
    assert.equal(researchResult.costUsd, 0.02);
    assert.deepEqual(or.research[0].plugins, [{ id: "web", max_results: 3 }]);
    assert.equal(or.research[0].messages[0].role, "system");
  } finally {
    await server.stop();
  }
});

test("offline without a test fetch, research is unavailable", async () => {
  const server = await startTestServer();
  try {
    const provider = await server.hub.project.plugins.exportsOf<ProviderExports>("rh.provider-openrouter");
    await assert.rejects(provider.research("x"), ResearchUnavailable);
  } finally {
    await server.stop();
  }
});
