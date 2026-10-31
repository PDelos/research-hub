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
