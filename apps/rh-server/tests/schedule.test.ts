// Spec scheduling (tasks 5.1-5.6) and the project overview (task 4.2), with a fixed clock and the ticker off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { validateCharter } from "../src/charter.ts";
import { dailySlot, localParts, MISSED, weeklySlot, zonedToUtc } from "../src/schedule.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { startTestServer, tempDir, TOKEN, type TestServer } from "./helpers.ts";

const at = (iso: string) => Date.parse(iso);

test("5.1 daily and weekly slots in UTC", () => {
  assert.deepEqual(dailySlot(at("2026-10-23T10:00:00Z"), "06:00", "UTC"), {
    kind: "sweep",
    key: "sweep:2026-10-23",
    at: at("2026-10-23T06:00:00Z"),
  });
  assert.equal(dailySlot(at("2026-10-23T05:59:00Z"), "06:00", "UTC").key, "sweep:2026-10-22");
  assert.equal(dailySlot(at("2026-10-23T10:00:00Z"), "06:00", "UTC", 2).key, "sweep:2026-10-21");
  // Friday 2026-10-23: the latest Sunday 07:00 slot is 2026-10-18, ISO week 42.
  const w = weeklySlot(at("2026-10-23T10:00:00Z"), "sun", "07:00", "UTC");
  assert.equal(w.key, "review:2026-W42");
  assert.equal(w.at, at("2026-10-18T07:00:00Z"));
  assert.equal(weeklySlot(at("2026-10-18T06:59:00Z"), "sun", "07:00", "UTC").key, "review:2026-W41");
});

test("5.1 Europe/Madrid across both 2026 DST changes keeps 06:00 local", () => {
  const tz = "Europe/Madrid";
  assert.equal(dailySlot(at("2026-03-28T12:00:00Z"), "06:00", tz).at, at("2026-03-28T05:00:00Z"), "winter UTC+1");
  assert.equal(dailySlot(at("2026-03-30T12:00:00Z"), "06:00", tz).at, at("2026-03-30T04:00:00Z"), "summer UTC+2");
  assert.equal(dailySlot(at("2026-10-24T12:00:00Z"), "06:00", tz).at, at("2026-10-24T04:00:00Z"));
  assert.equal(dailySlot(at("2026-10-26T12:00:00Z"), "06:00", tz).at, at("2026-10-26T05:00:00Z"));
  // The slot on a DST day is still one per local date.
  assert.equal(dailySlot(at("2026-03-29T12:00:00Z"), "06:00", tz).key, "sweep:2026-03-29");
  assert.equal(localParts(dailySlot(at("2026-03-29T12:00:00Z"), "06:00", tz).at, tz).hh, 6);
  // 02:30 does not exist on 2026-03-29 in Madrid: it lands just after the jump, at 03:30 local.
  assert.equal(localParts(zonedToUtc(2026, 3, 29, 2, 30, tz), tz).hh, 3);
});

test("5.1 schedule configuration is validated", () => {
  const base = { RH_MODE: "offline" } as NodeJS.ProcessEnv;
  assert.throws(
    () => loadConfig({ ...base, RH_TIMEZONE: "Mars/Olympus" }),
    (e: any) => e instanceof ConfigError && e.variable === "RH_TIMEZONE",
  );
  assert.throws(
    () => loadConfig({ ...base, RH_SWEEP_TIME: "25:00" }),
    (e: any) => e.variable === "RH_SWEEP_TIME",
  );
  assert.throws(
    () => loadConfig({ ...base, RH_REVIEW_TIME: "funday 07:00" }),
    (e: any) => e.variable === "RH_REVIEW_TIME",
  );
  assert.deepEqual(loadConfig({ ...base, RH_REVIEW_TIME: "Wed 08:30" }).schedule.review, {
    weekday: "wed",
    time: "08:30",
  });
});

// These tests check the schedule's records only; the sweep runner (v0.3) is off so requested slots stay requested.
async function activeServer(env: Record<string, string> = {}, dataDir?: string): Promise<TestServer> {
  const server = await startTestServer({ env, dataDir, hub: { ticker: false, sweeps: false } });
  const project = server.hub.project;
  if (!project.charters.approved()) {
    project.brief.write("# Protein LMs");
    project.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    project.charters.approve();
    project.db.prepare("UPDATE charters SET approved_at = '2026-01-01T00:00:00.000Z'").run();
  }
  return server;
}
const rows = (s: TestServer) =>
  s.hub.project.db.prepare("SELECT kind, slot, trigger, status, reason FROM scheduled_runs ORDER BY id").all() as any[];

test("5.2 defaults come from RH_SWEEP_TIME; saved changes override the environment and survive restarts", async () => {
  const t = tempDir();
  try {
    let server = await activeServer({ RH_SWEEP_TIME: "06:20" }, t.dir);
    try {
      const http = (method: string, path: string, body?: unknown) =>
        fetch(`${server.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
      let schedule = (await (await http("GET", "/v1/schedule")).json()) as any;
      assert.deepEqual(schedule, {
        timeZone: "UTC",
        sweep: { enabled: true, time: "06:20" },
        review: { enabled: true, weekday: "sun", time: "07:00" },
      });
      assert.equal((await http("PUT", "/v1/schedule", { sweep: { time: "25:99" } })).status, 400);
      schedule = (await (
        await http("PUT", "/v1/schedule", { sweep: { enabled: false }, review: { weekday: "wed" } })
      ).json()) as any;
      assert.equal(schedule.review.weekday, "wed");
    } finally {
      await server.stop();
    }
    server = await activeServer({ RH_SWEEP_TIME: "09:00" }, t.dir);
    try {
      const after = server.hub.project.scheduler.schedule();
      assert.equal(after.sweep.enabled, false, "turning the sweep off survives a restart");
      assert.equal(after.sweep.time, "06:20", "saved settings take precedence over a changed environment");
      assert.deepEqual(
        server.hub.project.scheduler.tick(at("2026-10-23T10:00:00Z")).map((r) => r.kind),
        ["review"],
        "no sweep while off",
      );
    } finally {
      await server.stop();
    }
  } finally {
    t.cleanup();
  }
});

test("5.3 exactly once per slot: two ticks and a restart inside the slot record one run", async () => {
  const t = tempDir();
  try {
    let server = await activeServer({}, t.dir);
    try {
      server.hub.project.scheduler.setSchedule({ review: { enabled: false } });
      assert.equal(server.hub.project.scheduler.tick(at("2026-10-23T06:00:30Z")).length, 1);
      assert.equal(server.hub.project.scheduler.tick(at("2026-10-23T06:01:30Z")).length, 0);
    } finally {
      await server.stop();
    }
    server = await activeServer({}, t.dir);
    try {
      assert.equal(server.hub.project.scheduler.tick(at("2026-10-23T06:02:00Z")).length, 0, "restart inside the slot");
      assert.deepEqual(
        rows(server).map((r) => [r.slot, r.status]),
        [["sweep:2026-10-23", "requested"]],
      );
    } finally {
      await server.stop();
    }
  } finally {
    t.cleanup();
  }
});

test("5.4 catch-up, charter not approved, and paused slots", async () => {
  const server = await activeServer();
  try {
    const s = server.hub.project.scheduler;
    s.setSchedule({ review: { enabled: false } });
    // Last sweep ran on the 21st; the hub was down on the 22nd and comes back on the 23rd at 10:00.
    s.tick(at("2026-10-21T06:00:30Z"));
    const down = s.tick(at("2026-10-23T10:00:00Z"));
    assert.deepEqual(
      down.map((r) => [r.slot, r.status, r.reason]),
      [
        ["sweep:2026-10-22", "skipped", MISSED],
        ["sweep:2026-10-23", "requested", null],
      ],
    );

    // Paused at the slot: skipped "project paused", and nothing is caught up after resuming.
    server.hub.project.state.pause();
    assert.deepEqual(
      s.tick(at("2026-10-24T06:00:30Z")).map((r) => [r.slot, r.reason]),
      [["sweep:2026-10-24", "project paused"]],
    );
    server.hub.project.state.resume(at("2026-10-24T07:00:00Z"));
    assert.equal(s.tick(at("2026-10-24T07:05:00Z")).length, 0);
    assert.deepEqual(
      s.tick(at("2026-10-25T06:00:30Z")).map((r) => r.status),
      ["requested"],
    );
  } finally {
    await server.stop();
  }
  const draftOnly = await startTestServer({ hub: { ticker: false } });
  try {
    const p = draftOnly.hub.project;
    p.brief.write("# x");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.scheduler.setSchedule({ review: { enabled: false } });
    assert.deepEqual(
      p.scheduler.tick(at("2026-10-23T06:00:30Z")).map((r) => [r.status, r.reason]),
      [["skipped", "charter not approved"]],
    );
  } finally {
    await draftOnly.stop();
  }
});

test("5.5 + 5.6 manual runs never take the scheduled slot; one active run per kind; the run log lists reasons", async () => {
  const server = await activeServer();
  try {
    const s = server.hub.project.scheduler;
    s.setSchedule({ review: { enabled: false } });
    const res = await fetch(`${server.url}/v1/runs/sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 202);
    assert.equal(((await res.json()) as any).trigger, "manual");
    assert.deepEqual(
      s.tick(at("2026-10-23T06:00:30Z")).map((r) => [r.slot, r.status]),
      [["sweep:2026-10-23", "requested"]],
    );
    server.hub.project.db.prepare("UPDATE scheduled_runs SET status = 'running' WHERE slot = 'sweep:2026-10-23'").run();
    const second = s.trigger("sweep");
    assert.equal(second.status, "skipped");
    assert.equal(second.reason, "sweep already running");
    const log = (await (
      await fetch(`${server.url}/v1/scheduled-runs`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as any;
    assert.deepEqual(
      log.map((r: any) => [r.trigger, r.status, r.reason]),
      [
        ["manual", "skipped", "sweep already running"],
        ["scheduled", "running", null],
        ["manual", "requested", null],
      ],
    );
    assert.equal(
      (await fetch(`${server.url}/v1/runs/nap`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
      404,
    );
  } finally {
    await server.stop();
  }
});

test("4.2 the overview shows status, version, next runs for an active project only, and the month's cost", async () => {
  const server = await activeServer({ RH_PROJECT_NAME: "proteins" });
  try {
    const get = async () =>
      (await (
        await fetch(`${server.url}/v1/project`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json()) as any;
    const active = await get();
    assert.equal(active.name, "proteins");
    assert.equal(active.status, "active");
    assert.equal(active.charterVersion, 1);
    assert.ok(Date.parse(active.next.sweep) > Date.now());
    assert.ok(Date.parse(active.next.review) > Date.now());
    assert.equal(active.next.timeZone, "UTC");
    assert.equal(typeof active.monthCostUsd, "number");
    await fetch(`${server.url}/v1/project/pause`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    const paused = await get();
    assert.equal(paused.status, "paused");
    assert.equal(paused.next.sweep, null);
  } finally {
    await server.stop();
  }
});
