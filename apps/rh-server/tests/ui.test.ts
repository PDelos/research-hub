// Spec deployment: one port serves the UI and the API; the browser reaches the API through the server-side proxy,
// which holds the token and only answers same-origin requests for hosts we serve (task 5.2).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startTestServer, TOKEN } from "./helpers.ts";

const DIST = join(import.meta.dirname, "../../rh-client-browser/dist");

test("the built UI exists (npm run build -w rh-client-browser)", () => {
  assert.ok(existsSync(join(DIST, "index.html")), `missing ${DIST}/index.html`);
});

test("/ serves the UI and its assets on the API port", async () => {
  const server = await startTestServer({ env: { RH_UI_DIR: DIST } });
  try {
    const page = await fetch(`${server.url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>research · Research Hub<\/title>/, "the title names the project");
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset, "a script asset");
    const script = await fetch(`${server.url}${asset}`);
    assert.equal(script.status, 200);
    const code = await script.text();
    assert.ok(code.includes("Run sweep now") && code.includes("How these scores were computed"), "the bundle has the Feed (v0.3)");
    assert.ok(code.includes("Add to knowledge base") && code.includes("precision@5"), "the bundle has judging (v0.4)");
    assert.equal((await fetch(`${server.url}/some/deep/link`)).status, 200, "SPA fallback");
  } finally {
    await server.stop();
  }
});

test("the proxy works without a token for same-origin requests and the token never reaches the page", async () => {
  const server = await startTestServer({ env: { RH_UI_DIR: DIST } });
  try {
    const host = new URL(server.url).host;
    const info = await fetch(`${server.url}/ui/v1/info`, { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(info.status, 200);
    const chat = await fetch(`${server.url}/ui/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://${host}` },
      body: JSON.stringify({ content: "from the browser", waitMs: 10_000 }),
    });
    assert.equal(chat.status, 200);
    assert.equal(((await chat.json()) as { status: string }).status, "done");
    const page = await (await fetch(`${server.url}/`)).text();
    const client = server.hub.config.clientToken;
    assert.ok(!page.includes(client) && !page.includes(TOKEN));
    for (const file of readdirSync(join(DIST, "assets"))) {
      const text = readFileSync(join(DIST, "assets", file), "utf8");
      assert.ok(!text.includes(client) && !text.includes(TOKEN), file);
    }
  } finally {
    await server.stop();
  }
});

test("the proxy refuses foreign hosts, cross-origin pages and non-JSON writes", async () => {
  const server = await startTestServer({ env: { RH_UI_DIR: DIST } });
  try {
    // fetch cannot set Host, so the rebinding case uses http.request.
    const url = new URL(`${server.url}/ui/v1/info`);
    const rebinding = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        { host: url.hostname, port: url.port, path: url.pathname, headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
    });
    assert.equal(rebinding, 421);
    const crossOrigin = await fetch(`${server.url}/ui/v1/info`, { headers: { origin: "https://evil.example" } });
    assert.equal(crossOrigin.status, 403);
    const crossSite = await fetch(`${server.url}/ui/v1/info`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    const form = await fetch(`${server.url}/ui/v1/chat`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "content=hi",
    });
    assert.equal(form.status, 415);
  } finally {
    await server.stop();
  }
});
