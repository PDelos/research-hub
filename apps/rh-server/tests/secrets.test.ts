// Spec deployment: credentials come from the environment only and never appear in the bundle, health, info or
// logs (task 5.3). Live mode with a fake key: startup makes no provider calls, so nothing is sent anywhere.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startTestServer, TOKEN } from "./test-server.ts";

const DIST = join(import.meta.dirname, "../../rh-client-browser/dist");
const KEY = "sk-or-v1-0000fake0000secret0000value0000";

test("the OpenRouter key and tokens appear in none of: bundle, /v1/health, /v1/info, logs", async () => {
  const server = await startTestServer({
    env: { RH_MODE: "live", OPENROUTER_API_KEY: KEY, RH_UI_DIR: DIST, RH_CLIENT_TOKEN: "client-token-abcdef123456" },
  });
  try {
    assert.equal((await server.client.health()).mode, "live");
    const secrets = [KEY, TOKEN, "client-token-abcdef123456"];
    const health = await (await fetch(`${server.url}/v1/health`)).text();
    const info = await (await fetch(`${server.url}/v1/info`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    const page = await (await fetch(`${server.url}/`)).text();
    const bundle = readdirSync(join(DIST, "assets")).map((f) => readFileSync(join(DIST, "assets", f), "utf8"));
    // A logged error that embeds the key must be scrubbed too.
    server.hub.log.error("test.leak_attempt", { message: `bad key ${KEY}`, authorization: `Bearer ${TOKEN}` });
    const logs = server.logs.join("\n");
    for (const secret of secrets)
      for (const [name, text] of Object.entries({ health, info, page, logs, bundle: bundle.join("\n") }))
        assert.ok(!text.includes(secret), `${name} contains a secret`);
    assert.ok(logs.includes("[redacted]"), "the leak attempt was redacted");
  } finally {
    await server.stop();
  }
});
