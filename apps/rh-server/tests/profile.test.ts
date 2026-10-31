// The core and full profiles (spec feature-profiles; design v2-0 D1–D3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const offline = { RH_MODE: "offline" };

test("RH_PROFILE defaults to core, accepts full, and refuses anything else naming the variable", () => {
  assert.equal(loadConfig(offline).profile, "core");
  assert.equal(loadConfig({ ...offline, RH_PROFILE: "full" }).profile, "full");
  assert.throws(
    () => loadConfig({ ...offline, RH_PROFILE: "lite" }),
    (error: unknown) =>
      error instanceof ConfigError && error.variable === "RH_PROFILE" && /core or full/.test(error.message),
  );
});

test("enablement.profile full: the manifest accepts it, and the plugin starts disabled unless the profile is full", async () => {
  const { parseManifest } = await import("../src/kernel/manifest.ts");
  const { contributionProblems } = await import("../src/kernel/contributions.ts");
  const { initiallyEnabled } = await import("../src/kernel/settings.ts");
  const manifest = parseManifest({
    id: "acme.advanced",
    version: "1.0.0",
    displayName: "Advanced",
    engines: { "research-hub": "^1.0.0" },
    activationEvents: ["onStartup"],
    contributes: { enablement: { profile: "full" } },
  });
  assert.deepEqual(contributionProblems(manifest), []);
  assert.equal(initiallyEnabled(manifest, { RH_PROFILE: "core" }), false);
  assert.equal(initiallyEnabled(manifest, { RH_PROFILE: "full" }), true);
  // Unset (a kernel used without the configuration): full, as before profiles existed.
  assert.equal(initiallyEnabled(manifest, {}), true);
  const wrong = parseManifest({ ...manifest, contributes: { enablement: { profile: "core" } } });
  assert.notDeepEqual(contributionProblems(wrong), []);
});

export const ADVANCED = [
  "rh.converter-docling",
  "rh.embedder-local",
  "rh.engineer",
  "rh.finder-method-transfer",
  "rh.finder-missing-links",
  "rh.finder-rising-topics",
  "rh.harness",
  "rh.knowledge",
  "rh.upgrades",
];

test("a new project in core starts with exactly the nine advanced plugins disabled; in full with none", async () => {
  const { startTestServer, tempDir } = await import("./test-server.ts");
  for (const profile of ["core", "full"] as const) {
    const temp = tempDir();
    const server = await startTestServer({ env: { RH_PROFILE: profile }, dataDir: temp.dir });
    try {
      // The Obsidian viewer's own switch (RH_KB_VIEWER) is not part of the profile.
      const disabled = server.hub.project.plugins.kernel
        .list()
        .filter((p) => p.builtin && p.state === "disabled" && p.id !== "rh.kb-obsidian")
        .map((p) => p.id)
        .toSorted();
      assert.deepEqual(disabled, profile === "core" ? ADVANCED : []);
    } finally {
      await server.stop();
      temp.cleanup();
    }
  }
});

test("switching an existing project: one commit each way, user choices stand, Undo keeps the profile", async () => {
  const { startTestServer, tempDir } = await import("./test-server.ts");
  const temp = tempDir();
  const run = async <T>(
    profile: "core" | "full",
    work: (server: Awaited<ReturnType<typeof startTestServer>>) => Promise<T>,
  ) => {
    const server = await startTestServer({ env: { RH_PROFILE: profile }, dataDir: temp.dir });
    try {
      return await work(server);
    } finally {
      await server.stop();
    }
  };
  const state = (server: Awaited<ReturnType<typeof startTestServer>>, id: string) =>
    server.hub.project.plugins.kernel.list().find((p) => p.id === id)!.state;
  const profileCommits = async (server: Awaited<ReturnType<typeof startTestServer>>) =>
    (await server.hub.project.plugins.state.history(200)).filter((h) => h.message.startsWith("profile:"));
  try {
    // A project that ran in full (no profile commit at creation).
    await run("full", async (server) => {
      assert.equal(state(server, "rh.knowledge"), "active");
      assert.equal((await profileCommits(server)).length, 0);
    });
    // First start in core: one commit turns the nine off.
    const undoTarget = await run("core", async (server) => {
      for (const id of ADVANCED) assert.equal(state(server, id), "disabled", id);
      const commits = await profileCommits(server);
      assert.deepEqual(
        commits.map((c) => [c.message, c.actor]),
        [["profile: core", "kernel"]],
      );
      return commits[0].id;
    });
    // Core again: nothing to switch. The user enables the knowledge review; it stays on after a restart.
    await run("core", async (server) => {
      assert.equal((await profileCommits(server)).length, 1);
      await server.hub.project.plugins.kernel.setEnabled("rh.knowledge", true);
    });
    await run("core", async (server) => {
      assert.notEqual(state(server, "rh.knowledge"), "disabled");
      assert.equal(state(server, "rh.harness"), "disabled");
      // Undo of the profile commit is refused while a later change touched the same plugin…
      await assert.rejects(server.hub.project.plugins.kernel.undo(undoTarget));
      // …and allowed once the plugin is back as the profile left it; then it turns the nine back on.
      await server.hub.project.plugins.kernel.setEnabled("rh.knowledge", false);
      await server.hub.project.plugins.kernel.undo(undoTarget);
      for (const id of ADVANCED) assert.notEqual(state(server, id), "disabled", id);
    });
    // Undo kept the profile: a restart in core does not switch again.
    await run("core", async (server) => {
      assert.equal((await profileCommits(server)).length, 1);
      assert.notEqual(state(server, "rh.harness"), "disabled");
      // Back to a plain core state for the last step.
      for (const id of ["rh.engineer", "rh.upgrades", "rh.harness"])
        await server.hub.project.plugins.kernel.setEnabled(id, false);
    });
    // Back to full: what the core profile turned off and is still off comes back on.
    await run("full", async (server) => {
      const commits = await profileCommits(server);
      assert.equal(commits[0].message, "profile: full");
      for (const id of ADVANCED) assert.notEqual(state(server, id), "disabled", id);
    });
  } finally {
    temp.cleanup();
  }
});
