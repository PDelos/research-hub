// Spec knowledge-viewer: the bundled viewer behind the hub (task 3.1), with a fake Ignis.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateCharter } from "../src/charter.ts";
import { loadConfig } from "../src/config.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { startTestServer, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dirname, "fixtures/fake-ignis");
const DIST = join(import.meta.dirname, "../../rh-client-browser/dist");

async function viewerServer(over: Record<string, unknown> = {}) {
  const t = tempDir();
  // Offline tests never download Obsidian: put a package in place.
  const app = join(t.dir, "kb-viewer", "obsidian-app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "index.html"), "<html></html>");
  writeFileSync(join(app, ".obsidian-version"), "1.14.4");
  const server = await startTestServer({
    dataDir: t.dir,
    env: { RH_UI_DIR: DIST },
    hub: { ticker: false, kbViewer: { enabled: true, dir: FAKE, restartDelays: [200], ...over } },
  });
  const projectRuntime = server.hub.project;
  projectRuntime.brief.write("# x");
  projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
  projectRuntime.charters.approve();
  projectRuntime.syncVault();
  const end = Date.now() + 15_000;
  while (projectRuntime.kbViewer.status().state !== "running" && over.enabled !== false) {
    if (Date.now() > end) throw new Error(JSON.stringify(projectRuntime.kbViewer.status()));
    await new Promise((r) => setTimeout(r, 50));
  }
  return { server, p: projectRuntime, done: async () => (await server.stop(), t.cleanup()) };
}

const host = (server: { port: number }) => `localhost:${server.port}`;

test("the viewer is served on the hub's origin: /kb/ and its own API paths, with the vault linked and no token passed on", async () => {
  const { server, p: projectRuntime, done } = await viewerServer();
  try {
    const page = await fetch(`http://${host(server)}/kb/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Fake Obsidian.*vaults:research/);
    const api = (await (
      await fetch(`http://${host(server)}/api/vault/info?vault=research`, {
        headers: { authorization: "Bearer secret-token-0123456789" },
      })
    ).json()) as any;
    assert.equal(api.path, "/api/vault/info?vault=research");
    assert.equal(api.auth, null, "the hub's tokens never reach the viewer");
    assert.equal(((await (await fetch(`http://${host(server)}/kb/app.js?v=1`)).json()) as any).path, "/app.js?v=1");
    assert.equal(
      ((await (await fetch(`http://${host(server)}/vault-files/sources/a.md`)).json()) as any).path,
      "/vault-files/sources/a.md",
    );
    // The hub's own assets still come from the hub; other /assets/ paths go to the viewer.
    const html = await (await fetch(`http://${host(server)}/`)).text();
    const own = html.match(/src="(\/assets\/[^"]+\.js)"/)![1];
    assert.match(await (await fetch(`http://${host(server)}${own}`)).text(), /Run sweep now/);
    assert.equal(
      ((await (await fetch(`http://${host(server)}/assets/overrides.css`)).json()) as any).path,
      "/assets/overrides.css",
    );
    // The hub API is unaffected.
    assert.equal((await fetch(`http://${host(server)}/v1/health`)).status, 200);
    const info = await server.client.info();
    assert.deepEqual(
      { state: info.kbViewer.state, ignis: info.kbViewer.ignisVersion, obsidian: info.kbViewer.obsidianVersion },
      { state: "running", ignis: "0.0.1-test", obsidian: "1.14.4" },
    );
    assert.equal(projectRuntime.kbViewer.target()!.host, "127.0.0.1");
  } finally {
    await done();
  }
});

test("cross-site requests, foreign hosts and foreign WebSocket origins are refused; same-origin WebSockets reach the viewer", async () => {
  const { server, done } = await viewerServer();
  try {
    assert.equal(
      (await fetch(`http://${host(server)}/kb/`, { headers: { "sec-fetch-site": "cross-site" } })).status,
      403,
    );
    assert.equal(
      (await fetch(`http://${host(server)}/api/fs/tree`, { headers: { origin: "https://evil.example" } })).status,
      403,
    );
    const foreign = await new Promise<number>((resolve) =>
      http.get(
        { host: "127.0.0.1", port: server.port, path: "/kb/", headers: { host: "evil.example" } },
        (r) => (r.resume(), resolve(r.statusCode!)),
      ),
    );
    assert.equal(foreign, 403, "a foreign Host header (DNS rebinding) is refused");
    const upgrade = (origin: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(server.port, "127.0.0.1", () =>
          socket.write(
            `GET /ws?vault=research HTTP/1.1\r\nHost: ${host(server)}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          ),
        );
        let data = "";
        socket.on("data", (d) => {
          data += d.toString("latin1");
          if (data.includes("hello") || data.includes("403")) {
            socket.end();
            resolve(data);
          }
        });
        socket.on("close", () => resolve(data));
      });
    const ok = await upgrade(`http://${host(server)}`);
    assert.match(ok, /^HTTP\/1\.1 101/);
    assert.match(ok, /X-Path: \/ws\?vault=research/);
    assert.match(ok, /hello/);
    assert.match(await upgrade("https://evil.example"), /^HTTP\/1\.1 403/);
  } finally {
    await done();
  }
});

test("the viewer listens on loopback only and restarts within 10 seconds after a crash; chat keeps working", async () => {
  const { server, p: projectRuntime, done } = await viewerServer();
  try {
    const { port } = projectRuntime.kbViewer.target()!;
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (external) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect(port, external);
        socket.on("connect", () => (socket.destroy(), resolve(false)));
        socket.on("error", () => resolve(true));
      });
      assert.ok(refused, `connecting to ${external}:${port} must fail`);
    }
    const crashedAt = Date.now();
    await fetch(`http://${host(server)}/api/crash`);
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(projectRuntime.kbViewer.status().state, "running");
    assert.equal((await fetch(`http://${host(server)}/kb/`)).status, 503, "a styled page while it is down");
    assert.equal((await server.client.health()).ok, true, "the hub is unaffected");
    while (projectRuntime.kbViewer.status().state !== "running") {
      assert.ok(Date.now() - crashedAt < 10_000, "restarted within 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(projectRuntime.kbViewer.status().restarts, 1);
    assert.equal((await fetch(`http://${host(server)}/kb/`)).status, 200);
  } finally {
    await done();
  }
});

test("disabled (RH_KB_VIEWER=off) and unavailable (no Ignis, or offline without Obsidian) are reported, never fatal", async () => {
  assert.equal(loadConfig({ RH_MODE: "offline", RH_KB_VIEWER: "off" } as NodeJS.ProcessEnv).kbViewer.enabled, false);
  assert.throws(
    () => loadConfig({ RH_MODE: "offline", RH_KB_VIEWER: "maybe" } as NodeJS.ProcessEnv),
    /RH_KB_VIEWER must be on or off/,
  );
  const off = await viewerServer({ enabled: false });
  try {
    assert.equal((await off.server.client.info()).kbViewer.state, "disabled");
    const page = await fetch(`http://${host(off.server)}/kb/`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /viewer is disabled: RH_KB_VIEWER=off/);
  } finally {
    await off.done();
  }
  const t = tempDir();
  const missing = await startTestServer({
    dataDir: t.dir,
    hub: { ticker: false, kbViewer: { enabled: true, dir: join(t.dir, "nowhere") } },
  });
  try {
    const projectRuntime = missing.hub.project;
    projectRuntime.brief.write("# x");
    projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    projectRuntime.charters.approve();
    projectRuntime.syncVault();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(projectRuntime.kbViewer.status().state, "unavailable");
    assert.match(projectRuntime.kbViewer.status().reason!, /Ignis is not installed/);
  } finally {
    await missing.stop();
    t.cleanup();
  }
  const t2 = tempDir();
  const noObsidian = await startTestServer({
    dataDir: t2.dir,
    hub: { ticker: false, kbViewer: { enabled: true, dir: FAKE } },
  });
  try {
    const p = noObsidian.hub.project;
    p.brief.write("# x");
    p.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    p.charters.approve();
    p.syncVault();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.kbViewer.status().state, "unavailable");
    assert.match(p.kbViewer.status().reason!, /offline mode makes no downloads/);
  } finally {
    await noObsidian.stop();
    t2.cleanup();
  }
});
