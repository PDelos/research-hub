import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_POINTS,
  fit,
  fits,
  fromPolicy,
  k,
  toPolicy,
  validatePoints,
} from "../src/compaction.ts";

test("defaults: background 100k, force 200k on a 1M window", () => {
  assert.deepEqual(DEFAULT_POINTS, { background: 100_000, force: 200_000 });
  assert.deepEqual(toPolicy(1_000_000), {
    enabled: true,
    reserveTokens: 800_000,
    backgroundTokens: 100_000,
    keepRecentTokens: 20_000,
  });
});

test("round trip through the pi-durable policy is stable", () => {
  const points = { background: 150_016, force: 300_032 };
  assert.deepEqual(fromPolicy(1_000_000, toPolicy(1_000_000, points)), fit(1_000_000, points));
});

test("fit clamps into small windows and keeps the gap", () => {
  const p = fit(128_000, DEFAULT_POINTS);
  assert.ok(fits(128_000, p), JSON.stringify(p));
  assert.equal(128_000 - p.force >= 16_384, true);
  assert.equal(p.force - p.background >= 1_024, true);
});

test("validatePoints explains every rejection", () => {
  assert.equal(validatePoints(1_000_000, DEFAULT_POINTS), undefined);
  assert.match(
    validatePoints(1_000_000, { background: 199_500, force: 200_000 })!,
    /below the force point/,
  );
  assert.match(validatePoints(1_000_000, { background: 100, force: 200_000 })!, /at least 4096/);
  assert.match(validatePoints(200_000, { background: 100_000, force: 190_000 })!, /leave at least/);
  assert.equal(k(100_000), "100k");
  assert.equal(k(1_000_000), "1M");
});
