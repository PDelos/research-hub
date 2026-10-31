// Spec weekly-upgrade: Embedder upgrade proposed (Approve a new embedder: live switch) (v1-4 task 1.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startTestServer, until } from "./test-server.ts";

// Exercises advanced features, so it runs in the full profile whatever RH_PROFILE says (v2-0 D7).
process.env.RH_PROFILE = "full";

test("changing the embedder's model or size re-embeds every paper in the background, without a restart, and undoes", async () => {
  const server = await startTestServer();
  try {
    const projectRuntime = server.hub.project;
    const found = await projectRuntime.papers.find({ query: "protein language models", limit: 5 });
    const id = found.papers[0].id;
    assert.equal(projectRuntime.papers.vectors.vector(id, "whole")?.length, 1024);

    await projectRuntime.plugins.kernel.configure("rh.embedder-openrouter", {
      model: "acme/other-embedding",
      dims: 256,
    });
    await until(
      () => found.papers.every((x) => projectRuntime.papers.vectors.vector(x.id, "whole")?.length === 256),
      20_000,
      "re-embedded at 256",
    );
    assert.ok(
      (await projectRuntime.papers.vectors.similar({ paperId: id }, { k: 3 })).length > 0,
      "similarity search works on the new vectors",
    );
    assert.equal(projectRuntime.plugins.kernel.get("rh.papers")?.state, "active");

    const change = (await projectRuntime.plugins.state.history())[0];
    assert.equal(change.message, "configure rh.embedder-openrouter: model, dims");
    await projectRuntime.plugins.kernel.undo(change.id);
    await until(() => projectRuntime.papers.vectors.vector(id, "whole")?.length === 1024, 20_000, "back to 1024");
  } finally {
    await server.stop();
  }
});
