import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attentionScore,
  gate,
  JevLedger,
  JevClient,
  normalized,
  rankHfs,
  type ScoreAnswer,
} from "../src/index.ts";

const s = (score: number, confidence = 0.8): ScoreAnswer => ({
  type: "score",
  score,
  confidence,
  legend: { "0": "a", "1": "b", "2": "c", "3": "d" },
  probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 },
});

test("normalized maps a score across its levels", () => {
  assert.equal(normalized(s(0)), 0);
  assert.equal(normalized(s(3)), 1);
  assert.equal(normalized(s(1.5)), 0.5);
});

test("rankHfs always ranks all three, highest first", () => {
  const r = rankHfs({ hype: s(0.3), facts: s(2.7), signal: s(2.4) });
  assert.deepEqual(
    r.ranked.map((x) => x.category),
    ["facts", "signal", "hype"],
  );
  assert.equal(r.primary, "facts");
  assert.deepEqual(r.labels, ["facts", "signal"]);
  assert.equal(r.scores.hype, 10);
  assert.equal(r.suspectCombo, false);
});

test("ties break signal, facts, hype", () => {
  const r = rankHfs({ hype: s(1.5), facts: s(1.5), signal: s(1.5) });
  assert.deepEqual(
    r.ranked.map((x) => x.category),
    ["signal", "facts", "hype"],
  );
});

test("hype and signal without facts is flagged", () => {
  const r = rankHfs({ hype: s(2.4), facts: s(0.6), signal: s(2.1) });
  assert.equal(r.suspectCombo, true);
});

test("attention puts signal plus facts above pure hype", () => {
  const best = attentionScore({ signal: 90, facts: 90, hype: 5 }, 0.9);
  const hype = attentionScore({ signal: 10, facts: 10, hype: 95 }, 0.9);
  const middle = attentionScore({ signal: 50, facts: 50, hype: 50 }, 0.5);
  assert.ok(best > middle && middle > hype, `${best} ${middle} ${hype}`);
  assert.ok(best <= 100 && hype >= 0);
});

test("gate uses confidence floors", () => {
  assert.equal(gate(s(1, 0.3)), "human");
  assert.equal(gate(s(1, 0.7)), "confirm");
  assert.equal(gate(s(1, 0.95)), "auto");
});

test("ledger totals and hands every call to its sink", async () => {
  const seen: unknown[] = [];
  const ledger = new JevLedger((r) => seen.push(r));
  const client = new JevClient({ provider: "mock" });
  ledger.record(
    await client.systemOne("x", { a: { type: "noul", instructions: "Is `x` fine?" } }),
    { command: "t", version: 1 },
  );
  ledger.fail(new Error("boom"), { command: "t" });
  assert.equal(ledger.calls, 2);
  assert.equal(ledger.failures, 1);
  assert.equal(ledger.mockCalls, 1);
  assert.equal(seen.length, 2);
  assert.match(ledger.summary(), /2 jev calls/);
});
