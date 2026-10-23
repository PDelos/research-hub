// Spec paper-sources: polite rate limiting and retries (task 3.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRetryAfter, PoliteHttp, SourceError } from "../src/papers/http.ts";

/** A virtual clock: sleep() waits for run() to advance time to its deadline. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const timers: { at: number; resolve: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((resolve) => timers.push({ at: now + ms, resolve })),
    /** Advance through every pending timer until `done` settles. */
    async run<T>(done: Promise<T>): Promise<T> {
      let settled = false;
      done.finally(() => (settled = true)).catch(() => {});
      while (!settled) {
        await new Promise((r) => setImmediate(r));
        if (settled || !timers.length) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        now = Math.max(now, next.at);
        next.resolve();
      }
      return done;
    },
  };
}

test("10 arXiv queries issued at once are sent at least 3 seconds apart", async () => {
  const clock = fakeClock();
  const sentAt: number[] = [];
  const http = new PoliteHttp({
    now: clock.now,
    sleep: clock.sleep,
    fetch: (async () => (sentAt.push(clock.now()), new Response("<feed/>"))) as typeof fetch,
  });
  const all = Promise.all(Array.from({ length: 10 }, (_, i) => http.text(`https://export.arxiv.org/api/query?q=${i}`, { source: "arxiv" })));
  await clock.run(all);
  assert.equal(sentAt.length, 10);
  for (let i = 1; i < sentAt.length; i++) assert.ok(sentAt[i] - sentAt[i - 1] >= 3_000, `gap ${i}: ${sentAt[i] - sentAt[i - 1]} ms`);
});

test("HTTP 429 is retried after Retry-After and then succeeds; the user agent carries the contact email", async () => {
  const clock = fakeClock();
  const calls: { at: number; ua: string | null }[] = [];
  const http = new PoliteHttp({
    now: clock.now,
    sleep: clock.sleep,
    contactEmail: "me@example.org",
    fetch: (async (_url: string, init: RequestInit) => {
      calls.push({ at: clock.now(), ua: new Headers(init.headers).get("user-agent") });
      return calls.length === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
        : Response.json({ ok: true });
    }) as typeof fetch,
  });
  assert.deepEqual(await clock.run(http.json("https://api.openalex.org/works", { source: "openalex" })), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at - calls[0].at, 7_000);
  assert.match(calls[0].ua!, /^research-hub\/\S+ \(mailto:me@example\.org\)$/);
});

test("503 three times fails with the reason; 400 fails at once; budget stops retries", async () => {
  const clock = fakeClock();
  let calls = 0;
  const unavailable = new PoliteHttp({ now: clock.now, sleep: clock.sleep, fetch: (async () => (calls++, new Response("", { status: 503 }))) as typeof fetch });
  await assert.rejects(clock.run(unavailable.json("https://www.ebi.ac.uk/x", { source: "europepmc" })), (e: unknown) => e instanceof SourceError && e.source === "europepmc" && /HTTP 503 after 3 attempts/.test(e.message));
  assert.equal(calls, 3);

  calls = 0;
  const bad = new PoliteHttp({ now: clock.now, sleep: clock.sleep, fetch: (async () => (calls++, new Response("", { status: 400 }))) as typeof fetch });
  await assert.rejects(clock.run(bad.json("https://www.ebi.ac.uk/x", { source: "europepmc" })), /HTTP 400/);
  assert.equal(calls, 1);

  calls = 0;
  const longWait = new PoliteHttp({ now: clock.now, sleep: clock.sleep, fetch: (async () => (calls++, new Response("", { status: 429, headers: { "retry-after": "50" } }))) as typeof fetch });
  await assert.rejects(clock.run(longWait.json("https://api.openalex.org/x", { source: "openalex", budgetMs: 30_000 })), /exceed the 30 s budget/);
  assert.equal(calls, 1);

  calls = 0;
  const flaky = new PoliteHttp({ now: clock.now, sleep: clock.sleep, fetch: (async () => { calls++; if (calls < 3) throw new TypeError("fetch failed"); return Response.json([1]); }) as typeof fetch });
  assert.deepEqual(await clock.run(flaky.json("https://api.openalex.org/y", { source: "openalex" })), [1]);
});

test("404 is returned to the caller as not found, and Retry-After parses seconds and dates", async () => {
  const http = new PoliteHttp({ fetch: (async () => new Response("", { status: 404 })) as typeof fetch });
  assert.equal((await http.request("https://api.openalex.org/works/doi:10.1/x", { source: "openalex" })).status, 404);
  assert.equal(parseRetryAfter("5", 0), 5_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(parseRetryAfter("600", 0), 60_000);
  assert.equal(parseRetryAfter(null, 0), undefined);
});
