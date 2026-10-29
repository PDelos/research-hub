// Spec plugin-system: Permissions, Kernel API versioning (task 1.5): the rh API with permission enforcement
// (undeclared host, forbidden file, undeclared secret, other plugins' tables), the daily budget, and what a
// plugin registers (events, commands, schedules, processes) going away with it.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createRhApi,
  EventBus,
  RH_API_VERSION,
  ScheduleRegistry,
  tablePrefix,
  type KernelServices,
  type RhApi,
} from "../src/kernel/api.ts";
import { ContributionRegistry } from "../src/kernel/contributions.ts";
import { PluginKernel, type PluginModule } from "../src/kernel/lifecycle.ts";
import { BudgetExceeded, Budgets, PermissionDenied } from "../src/kernel/permissions.ts";
import { discover, initialPlugins } from "../src/kernel/registry.ts";
import { PluginState } from "../src/kernel/state.ts";
import { createLogger } from "../src/logger.ts";
import { tempDir } from "./test-server.ts";

function plugin(root: string, folder: string, manifest: Record<string, unknown>) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(
    join(root, folder, "rh-plugin.json"),
    JSON.stringify({
      version: "1.0.0",
      displayName: folder,
      engines: { "research-hub": "^1.0.0" },
      activationEvents: ["onStartup"],
      ...manifest,
    }),
  );
}

async function boot(dir: string, modules: Record<string, PluginModule>, extra: Partial<KernelServices> = {}) {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
  const root = join(dir, "plugins");
  const discovery = discover({ builtinDir: root });
  assert.deepEqual(discovery.invalid, []);
  const state = new PluginState(join(dir, "data"));
  await state.open(() => initialPlugins(discovery, {}));
  let day = new Date("2026-10-26T10:00:00Z");
  const db = new DatabaseSync(":memory:");
  const events = new EventBus(log);
  const services: KernelServices = {
    db,
    vaultDir: join(dir, "vault"),
    storageRoot: join(state.dir, "data"),
    env: { OPENROUTER_API_KEY: "sk-test-key-123456", OTHER_TOKEN: "t0k3n-abcdefgh" },
    log,
    events,
    budgets: new Budgets(db, {
      now: () => day,
      onExceeded: (pluginId, limitUsd) => events.emit("budget.exceeded", { pluginId, limitUsd }),
    }),
    contributions: undefined as unknown as ContributionRegistry,
    schedules: new ScheduleRegistry(),
    fetch: (async (input: string | URL | Request) => Response.json({ url: String(input) })) as typeof fetch,
    providers: {},
    ...extra,
  };
  const kernel = new PluginKernel({
    discovery,
    state,
    log,
    env: {},
    load: async (p) => modules[p.manifest.id] ?? {},
    api: (p, subs) => createRhApi(p, services, subs),
  });
  services.contributions = new ContributionRegistry(kernel, discovery);
  await kernel.start();
  return { kernel, services, lines, setDay: (d: string) => (day = new Date(d)) };
}

/** Capture a plugin's rh API from its activate. */
function capture(into: { rh?: RhApi }): PluginModule {
  return { activate: (context) => void (into.rh = context.rh) };
}

test("the API reports its version and a plugin reaches only its declared hosts, logged when refused", async () => {
  const temp = tempDir();
  try {
    plugin(join(temp.dir, "plugins"), "x", {
      id: "rh.source-x",
      permissions: { network: ["export.arxiv.org", "*.openalex.org"] },
    });
    const x: { rh?: RhApi } = {};
    const { lines } = await boot(temp.dir, { "rh.source-x": capture(x) });
    const rh = x.rh!;
    assert.equal(rh.version, RH_API_VERSION);
    assert.equal(RH_API_VERSION, "1.0.0");
    assert.deepEqual(await rh.http.json("https://export.arxiv.org/api/query"), {
      url: "https://export.arxiv.org/api/query",
    });
    assert.ok(await rh.http.json("https://api.openalex.org/works"));
    await assert.rejects(rh.http.json("https://example.com/"), (error: unknown) => {
      assert.ok(error instanceof PermissionDenied);
      assert.equal(error.message, "rh.source-x may not reach example.com");
      return true;
    });
    await assert.rejects(rh.http.json("https://openalex.org.evil.com/"), /may not reach openalex\.org\.evil\.com/);
    await assert.rejects(rh.http.json("file:///etc/passwd"), /may only use http\(s\)/);
    const denied = lines.filter((l) => l.event === "plugin.permission_denied");
    assert.deepEqual(denied[0], { ...denied[0], plugin: "rh.source-x", kind: "network", target: "example.com" });
  } finally {
    temp.cleanup();
  }
});

test("files: own storage always, the vault only as declared, never outside a scope; secrets only as declared", async () => {
  const temp = tempDir();
  try {
    mkdirSync(join(temp.dir, "vault", "sources"), { recursive: true });
    writeFileSync(join(temp.dir, "vault", "sources", "a.md"), "# A");
    plugin(join(temp.dir, "plugins"), "reader", {
      id: "acme.reader",
      permissions: { files: ["vault:read"], secrets: ["OPENROUTER_API_KEY"] },
    });
    plugin(join(temp.dir, "plugins"), "writer", { id: "acme.writer", permissions: { files: ["vault:read-write"] } });
    const reader: { rh?: RhApi } = {};
    const writer: { rh?: RhApi } = {};
    await boot(temp.dir, { "acme.reader": capture(reader), "acme.writer": capture(writer) });
    const api = reader.rh!;
    api.files.write("storage", "cache/state.json", "{}");
    assert.equal(api.files.read("storage", "cache/state.json"), "{}");
    assert.equal(api.files.read("vault", "sources/a.md"), "# A");
    assert.deepEqual(api.files.list("vault", "sources"), ["a.md"]);
    assert.throws(() => api.files.write("vault", "sources/a.md", "changed"), /acme\.reader may not write vault files/);
    assert.throws(
      () => api.files.read("storage", "../../../../etc/passwd"),
      /may not reach .* outside its storage folder/,
    );
    assert.throws(() => api.files.write("plugin", "rh-plugin.json", "{}"), /may not change its own installed files/);
    assert.equal(api.secrets.get("OPENROUTER_API_KEY"), "sk-test-key-123456");
    assert.throws(() => api.secrets.get("OTHER_TOKEN"), /acme\.reader may not read the secret OTHER_TOKEN/);

    writer.rh!.files.write("vault", "concepts/new.md", "# New");
    assert.equal(readFileSync(join(temp.dir, "vault", "concepts", "new.md"), "utf8"), "# New");
    assert.throws(() => writer.rh!.secrets.get("OPENROUTER_API_KEY"), PermissionDenied);
  } finally {
    temp.cleanup();
  }
});

test("a plugin's migrations run once and may only touch its own tables", async () => {
  const temp = tempDir();
  try {
    plugin(join(temp.dir, "plugins"), "notes", { id: "acme.notes" });
    const x: { rh?: RhApi } = {};
    const { services } = await boot(temp.dir, { "acme.notes": capture(x) });
    const rh = x.rh!;
    const notes = rh.db.table("notes");
    assert.equal(notes, `${tablePrefix("acme.notes")}notes`);
    assert.equal(notes, "p_acme_notes__notes");
    const migrations = [
      { version: 1, sql: `CREATE TABLE ${notes} (id INTEGER PRIMARY KEY, body TEXT)` },
      { version: 2, sql: `CREATE INDEX ${rh.db.table("notes_body")} ON ${notes} (body)` },
    ];
    assert.equal(rh.db.migrate(migrations), 2);
    assert.equal(rh.db.migrate(migrations), 0);
    rh.db.prepare(`INSERT INTO ${notes} (body) VALUES (?)`).run("hello");
    assert.throws(
      () => rh.db.migrate([{ version: 3, sql: "CREATE TABLE papers (id INTEGER)" }]),
      /acme\.notes may only create and change its own tables \(p_acme_notes__\*\), not papers/,
    );
    assert.throws(() => rh.db.migrate([{ version: 3, sql: "DROP TABLE cards" }]), PermissionDenied);
    const recorded = services.db
      .prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'acme.notes' ORDER BY version")
      .all();
    assert.deepEqual(
      recorded.map((r) => Number(r.version)),
      [1, 2],
    );
  } finally {
    temp.cleanup();
  }
});

test("calls fail once the daily budget is reached, the user is notified once, and the next day resets it", async () => {
  const temp = tempDir();
  try {
    plugin(join(temp.dir, "plugins"), "scout", {
      id: "acme.scout",
      permissions: { budgetUsdPerDay: 0.1, network: ["openrouter.ai"] },
    });
    plugin(join(temp.dir, "plugins"), "free", { id: "acme.free" });
    const scout: { rh?: RhApi } = {};
    const free: { rh?: RhApi } = {};
    const models = { complete: async () => ({ text: "ok", model: "m", costUsd: 0.04 }) };
    const { services, setDay } = await boot(
      temp.dir,
      { "acme.scout": capture(scout), "acme.free": capture(free) },
      { providers: { models } },
    );
    const notices: unknown[] = [];
    services.events.on("budget.exceeded", (p) => notices.push(p));
    const rh = scout.rh!;
    for (let i = 0; i < 3; i++) assert.equal((await rh.models.complete({ prompt: "hi" })).text, "ok");
    assert.ok(Math.abs(services.budgets.spent("acme.scout") - 0.12) < 1e-9);
    await assert.rejects(rh.models.complete({ prompt: "hi" }), BudgetExceeded);
    await assert.rejects(
      rh.http.json("https://openrouter.ai/api/v1/search", { costUsd: 0.02 }),
      /reached its budget of \$0\.10 for today/,
    );
    await assert.rejects(rh.models.complete({ prompt: "hi" }), BudgetExceeded);
    assert.deepEqual(notices, [{ pluginId: "acme.scout", limitUsd: 0.1 }]);
    // Another plugin's spending is its own; a plugin without a budget is not limited.
    for (let i = 0; i < 5; i++) await free.rh!.models.complete({ prompt: "hi" });
    setDay("2026-10-27T00:00:01Z");
    assert.equal((await rh.models.complete({ prompt: "hi" })).text, "ok");
    // Without an active provider the call says so.
    services.providers.models = undefined;
    await assert.rejects(rh.models.complete({ prompt: "hi" }), /no model provider plugin is active/);
    assert.throws(() => rh.proposals.submit({}), /proposals arrive with the Upgrades tab/);
  } finally {
    temp.cleanup();
  }
});

test("event handlers, commands, schedules and processes registered by a plugin end when it is disabled", async () => {
  const temp = tempDir();
  try {
    const root = join(temp.dir, "plugins");
    plugin(root, "watcher", {
      id: "acme.watcher",
      contributes: {
        commands: [{ id: "watcher.count", title: "Count" }],
        processes: [{ id: "server", entry: "server.mjs" }],
      },
    });
    writeFileSync(
      join(root, "watcher", "server.mjs"),
      "import { createServer } from 'node:http'; createServer((q, s) => s.end(`up ${process.env.OPENROUTER_API_KEY ?? 'no secrets'}`)).listen(Number(process.env.PORT));",
    );
    let seen = 0;
    let port = 0;
    const modules: Record<string, PluginModule> = {
      "acme.watcher": {
        async activate({ rh }) {
          rh.events.on("card.created", () => void seen++);
          rh.commands.register("watcher.count", () => seen);
          rh.scheduler.register("watcher-tick", () => undefined);
          port = (await rh.processes.start("server")).port;
        },
      },
    };
    process.env.OPENROUTER_API_KEY ??= "sk-should-not-leak-1234";
    const { kernel, services } = await boot(temp.dir, modules);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "up no secrets");
    services.events.emit("card.created", { cardId: 1, sweepId: 1 });
    assert.equal(await services.contributions.executeCommand("watcher.count"), 1);
    assert.deepEqual(services.schedules.kinds(), [{ kind: "watcher-tick", pluginId: "acme.watcher" }]);

    await kernel.setEnabled("acme.watcher", false);
    services.events.emit("card.created", { cardId: 2, sweepId: 1 });
    assert.equal(seen, 1);
    assert.deepEqual(services.schedules.kinds(), []);
    await assert.rejects(
      services.contributions.executeCommand("watcher.count"),
      /no enabled plugin offers the command/,
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  } finally {
    temp.cleanup();
  }
});
