// Spec plugin-system: Isolation of external code, Install and uninstall, Permissions (task 3.1): external plugins
// run in their own restricted process; install needs approval; crashes and hangs fail only the plugin.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { call, say } from "@rh/durable-agent";
import { openProjectDb } from "../src/db.ts";
import { startPluginHost } from "../src/kernel/host.ts";
import { InstallRefused } from "../src/kernel/install.ts";
import { createLogger } from "../src/logger.ts";
import { startTestServer, tempDir, until } from "./test-server.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/plugins");

async function host(options: { callTimeoutMs?: number } = {}) {
  const temp = tempDir();
  mkdirSync(join(temp.dir, "builtin"));
  const { db } = openProjectDb(join(temp.dir, "project.sqlite"));
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ write: (l) => lines.push(JSON.parse(l)) });
  const pluginHost = await startPluginHost({
    dataDir: temp.dir,
    db,
    vaultDir: join(temp.dir, "vault"),
    log,
    builtinDir: join(temp.dir, "builtin"),
    ...(options.callTimeoutMs ? { pluginCallTimeoutMs: options.callTimeoutMs } : {}),
  });
  return {
    h: pluginHost,
    t: temp,
    lines,
    db,
    install: async (folder: string) =>
      pluginHost.installer.confirm((await pluginHost.installer.prepare({ folder })).planId),
    done: async () => (await pluginHost.stop(), db.close(), temp.cleanup()),
  };
}

test("installing shows contributions and permissions first; the plugin runs only after approval", async () => {
  const env = await host();
  try {
    const plan = await env.h.installer.prepare({ folder: join(FIXTURES, "acme.sample") });
    assert.equal(plan.id, "acme.sample");
    assert.deepEqual(plan.permissions, { network: ["export.arxiv.org"] });
    assert.deepEqual(
      plan.contributions.chatTools.map((t) => t.name),
      ["sample_echo"],
    );
    assert.deepEqual(Object.keys(plan.contributions.points), ["papers.source"]);
    assert.equal(env.h.kernel.get("acme.sample"), undefined, "nothing is installed before approval");
    assert.equal(env.h.state.current().plugins["acme.sample"], undefined);

    await env.h.installer.confirm(plan.planId);
    assert.equal(env.h.kernel.get("acme.sample")?.state, "active");
    const entry = env.h.state.current().plugins["acme.sample"];
    assert.equal(entry.version, "0.1.0");
    assert.match(entry.hash!, /^sha256-/);
    assert.deepEqual(entry.source, { kind: "folder", path: join(FIXTURES, "acme.sample") });
    assert.equal((await env.h.state.history())[0].message, "install acme.sample 0.1.0");
    assert.equal(await env.h.contributions.callChatTool("sample_echo", { text: "hi" }), "echo hi");
    await assert.rejects(env.h.installer.confirm(plan.planId), /was not prepared, or was already confirmed/);
  } finally {
    await env.done();
  }
});

test("an external plugin sees no secrets, no network and no files but its own; rh.http reaches only declared hosts", async () => {
  const env = await host();
  try {
    await env.install(join(FIXTURES, "acme.sample"));
    const run = (id: string, args?: unknown) => env.h.contributions.executeCommand(id, args);
    assert.deepEqual(await run("sample.env"), ["PATH"]);
    assert.equal(await run("sample.direct"), "blocked");
    assert.equal(await run("sample.readEtc"), "ERR_ACCESS_DENIED");
    assert.equal(await run("sample.fetch", "https://example.com/"), "refused: acme.sample may not reach example.com");
    assert.ok(
      env.lines.some(
        (l) => l.event === "plugin.permission_denied" && l.plugin === "acme.sample" && l.target === "example.com",
      ),
    );
    await run("sample.remember", "kept");
    assert.equal(await run("sample.recall"), "kept");
  } finally {
    await env.done();
  }
});

test("a plugin that throws while activating, crashes or hangs fails alone with the reason", async () => {
  const env = await host({ callTimeoutMs: 500 });
  try {
    await env.install(join(FIXTURES, "acme.crashy"));
    assert.equal(env.h.kernel.get("acme.crashy")?.state, "failed");
    assert.equal(env.h.kernel.get("acme.crashy")?.reason, "crashy cannot start");

    await env.install(join(FIXTURES, "acme.sample"));
    assert.equal(await env.h.contributions.executeCommand("sample.crash"), "bye");
    await until(() => env.h.kernel.get("acme.sample")?.state === "failed", 5_000, "crash noticed");
    assert.equal(env.h.kernel.get("acme.sample")?.reason, "the plugin process exited (code 3)");

    // Enabling it again (re-applying) gives it a fresh process.
    await env.h.kernel.setEnabled("acme.sample", true);
    assert.equal(env.h.kernel.get("acme.sample")?.state, "active");
    assert.equal(await env.h.contributions.callChatTool("sample_echo", { text: "again" }), "echo again");

    await assert.rejects(env.h.contributions.executeCommand("sample.hang"), /did not answer within 0\.5 s/);
    assert.equal(env.h.kernel.get("acme.sample")?.state, "failed");
    assert.equal(env.h.kernel.get("acme.sample")?.reason, "did not answer within 0.5 s");
  } finally {
    await env.done();
  }
});

test("an invalid plugin is refused with the field and nothing changes", async () => {
  const env = await host();
  try {
    const before = await env.h.state.history();
    await assert.rejects(env.h.installer.prepare({ folder: join(FIXTURES, "acme.unversioned") }), (error: unknown) => {
      assert.ok(error instanceof InstallRefused);
      assert.deepEqual(error.problems, ["engines.research-hub: required"]);
      return true;
    });
    assert.deepEqual(await env.h.state.history(), before);
    assert.equal(existsSync(join(env.t.dir, "plugins", "installed", "acme.unversioned")), false);
  } finally {
    await env.done();
  }
});

test("uninstalling keeps the plugin's data unless asked; a reinstall finds it again", async () => {
  const env = await host();
  try {
    await env.install(join(FIXTURES, "acme.sample"));
    await env.h.contributions.executeCommand("sample.remember", "still here");
    await env.h.installer.uninstall("acme.sample");
    assert.equal(env.h.kernel.get("acme.sample"), undefined);
    assert.equal(env.h.state.current().plugins["acme.sample"], undefined);
    assert.ok(existsSync(join(env.t.dir, "plugins", "data", "acme.sample", "memo.txt")));

    await env.install(join(FIXTURES, "acme.sample"));
    assert.equal(await env.h.contributions.executeCommand("sample.recall"), "still here");
    await env.h.installer.uninstall("acme.sample", { deleteData: true });
    assert.equal(existsSync(join(env.t.dir, "plugins", "data", "acme.sample")), false);
    assert.deepEqual(
      (await env.h.state.history()).slice(0, 4).map((h) => h.message),
      [
        "uninstall acme.sample and delete its data",
        "install acme.sample 0.1.0",
        "uninstall acme.sample",
        "install acme.sample 0.1.0",
      ],
    );
  } finally {
    await env.done();
  }
});

test("an installed plugin whose files changed does not run", async () => {
  const env = await host();
  await env.install(join(FIXTURES, "acme.sample"));
  await env.h.stop();
  writeFileSync(join(env.t.dir, "plugins", "installed", "acme.sample", "main.mjs"), "export function activate() {}");
  const again = await startPluginHost({
    dataDir: env.t.dir,
    db: env.db,
    vaultDir: join(env.t.dir, "vault"),
    log: createLogger({ write: () => {} }),
    builtinDir: join(env.t.dir, "builtin"),
  });
  try {
    assert.equal(again.kernel.get("acme.sample")?.state, "incompatible");
    assert.equal(again.kernel.get("acme.sample")?.reason, "its files changed since it was installed; reinstall it");
  } finally {
    await again.stop();
    env.db.close();
    env.t.cleanup();
  }
});

function git(cwd: string, ...args: string[]) {
  assert.equal(spawnSync("git", args, { cwd }).status, 0, args.join(" "));
}

/** A git smart-HTTP server (git http-backend as CGI) for one repository folder. */
function gitServer(root: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method!,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
      },
    });
    request.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (c) => chunks.push(c));
    cgi.on("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, split).toString().split("\r\n");
      let status = 200;
      for (const line of head) {
        const [header, ...valueParts] = line.split(": ");
        if (header.toLowerCase() === "status") status = Number(valueParts.join(": ").split(" ")[0]);
        else response.setHeader(header, valueParts.join(": "));
      }
      response.statusCode = status;
      response.end(raw.subarray(split + 4));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }),
    ),
  );
}

test(
  "a plugin installs from a git URL",
  { skip: spawnSync("git", ["--version"]).status !== 0 && "git is not installed" },
  async () => {
    const env = await host();
    const repo = join(env.t.dir, "repos", "sample.git");
    const work = join(env.t.dir, "work");
    cpSync(join(FIXTURES, "acme.sample"), work, { recursive: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "sample");
    mkdirSync(join(env.t.dir, "repos"));
    git(env.t.dir, "clone", "-q", "--bare", work, repo);
    const server = await gitServer(join(env.t.dir, "repos"));
    try {
      const plan = await env.h.installer.prepare({ git: `${server.url}/sample.git` });
      assert.deepEqual(plan.source, { kind: "git", url: `${server.url}/sample.git` });
      await env.h.installer.confirm(plan.planId);
      assert.equal(env.h.kernel.get("acme.sample")?.state, "active");
      assert.equal(existsSync(join(env.t.dir, "plugins", "installed", "acme.sample", ".git")), false);
      assert.equal(
        readFileSync(join(env.t.dir, "plugins", "installed", "acme.sample", "rh-plugin.json"), "utf8"),
        readFileSync(join(FIXTURES, "acme.sample", "rh-plugin.json"), "utf8"),
      );
    } finally {
      server.close();
      await env.done();
    }
  },
);

test("in a project, an installed plugin's paper source joins searches and its chat tool reaches the desk", async () => {
  const temp = tempDir();
  let server = await startTestServer({ dataDir: temp.dir });
  try {
    const { installer } = server.hub.project.plugins;
    await installer.confirm((await installer.prepare({ folder: join(FIXTURES, "acme.sample") })).planId);
    const found = await server.hub.project.papers.find({ query: "protein folding", limit: 20 });
    assert.deepEqual(
      found.sources.find((x) => x.source === "sample"),
      { source: "sample", status: "ok", count: 1 },
    );
    assert.ok(found.papers.some((p) => p.title === "Sample paper on protein folding" && p.sources.includes("sample")));
    await server.stop();

    // After a restart the desk offers the plugin's tool; the (scripted) model calls it.
    server = await startTestServer({
      dataDir: temp.dir,
      hub: {
        fauxRules: [
          (turn) => {
            const result = turn.results.find((r) => r.name === "sample_echo");
            return result ? say(`The plugin said: ${result.text}`) : call("sample_echo", { text: "from the desk" });
          },
        ],
      },
    });
    const sent = await server.client.send("use the sample tool", { waitMs: 15_000 });
    assert.equal(sent.status, "done");
    assert.equal(sent.answer?.text, "The plugin said: echo from the desk");
  } finally {
    await server.stop();
    temp.cleanup();
  }
});
