// Spec weekly-upgrade: Embedder upgrade proposed (Approve a new embedder: live switch) (v1-4 task 1.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startTestServer, until } from "./helpers.ts";

test("changing the embedder's model or size re-embeds every paper in the background, without a restart, and undoes", async () => {
  const server = await startTestServer();
  try {
    const p = server.hub.project;
    const found = await p.papers.find({ query: "protein language models", limit: 5 });
    const id = found.papers[0].id;
    assert.equal(p.papers.vectors.vector(id, "whole")?.length, 1024);

    await p.plugins.kernel.configure("rh.embedder-openrouter", { model: "acme/other-embedding", dims: 256 });
    await until(
      () => found.papers.every((x) => p.papers.vectors.vector(x.id, "whole")?.length === 256),
      20_000,
      "re-embedded at 256",
    );
    assert.ok(
      (await p.papers.vectors.similar({ paperId: id }, { k: 3 })).length > 0,
      "similarity search works on the new vectors",
    );
    assert.equal(p.plugins.kernel.get("rh.papers")?.state, "active");

    const change = (await p.plugins.state.history())[0];
    assert.equal(change.message, "configure rh.embedder-openrouter: model, dims");
    await p.plugins.kernel.undo(change.id);
    await until(() => p.papers.vectors.vector(id, "whole")?.length === 1024, 20_000, "back to 1024");
  } finally {
    await server.stop();
  }
});
