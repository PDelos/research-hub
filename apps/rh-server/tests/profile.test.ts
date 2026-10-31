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
