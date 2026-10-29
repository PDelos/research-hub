// new-project.sh creates non-interfering projects: distinct ports, compose names and staggered sweep times (task 8.8).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./test-server.ts";

const SCRIPT = join(import.meta.dirname, "../../../new-project.sh");
const run = (args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
const env = (file: string) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

test("two projects get distinct ports, compose names, tokens and sweep times 20 minutes apart", () => {
  const temp = tempDir();
  try {
    const spawnSyncReturns = run(["proteins", "--base", temp.dir]);
    assert.equal(spawnSyncReturns.status, 0, spawnSyncReturns.stderr);
    const created = run(["genomics", "--base", temp.dir]);
    assert.equal(created.status, 0, created.stderr);
    const ea = env(join(temp.dir, "proteins/.env"));
    const eb = env(join(temp.dir, "genomics/.env"));
    assert.equal(ea.RH_PROJECT_NAME, "proteins");
    assert.equal(eb.RH_PROJECT_NAME, "genomics");
    assert.notEqual(ea.RH_PUBLISH_PORT, eb.RH_PUBLISH_PORT);
    assert.equal((Number(eb.RH_PUBLISH_PORT) - 4850) % 10, 0);
    assert.equal(ea.RH_SWEEP_TIME, "06:00");
    assert.equal(eb.RH_SWEEP_TIME, "06:20");
    assert.notEqual(ea.RH_API_TOKEN, eb.RH_API_TOKEN);
    assert.match(ea.RH_API_TOKEN, /^[0-9a-f]{48}$/);
    assert.match(readFileSync(join(temp.dir, "genomics/docker-compose.yml"), "utf8"), /^name: rh-genomics$/m);
    assert.ok(existsSync(join(temp.dir, "genomics/data")));
    assert.equal(statSync(join(temp.dir, "genomics/.env")).mode & 0o777, 0o600, ".env is private");
    assert.match(created.stdout, new RegExp(`http://genomics\\.localhost:${eb.RH_PUBLISH_PORT}`));
  } finally {
    temp.cleanup();
  }
});

test("bad or existing names are refused", () => {
  const temp = tempDir();
  try {
    assert.equal(run(["Bad Name", "--base", temp.dir]).status, 2);
    assert.equal(run(["ok", "--base", temp.dir]).status, 0);
    const again = run(["ok", "--base", temp.dir]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
  } finally {
    temp.cleanup();
  }
});

test("the sweep time wraps past midnight", () => {
  const temp = tempDir();
  try {
    run(["late", "--base", temp.dir]);
    const file = join(temp.dir, "late/.env");
    const text = readFileSync(file, "utf8").replace(/^RH_SWEEP_TIME=.*$/m, "RH_SWEEP_TIME=23:50");
    writeFileSync(file, text);
    run(["next", "--base", temp.dir]);
    assert.equal(env(join(temp.dir, "next/.env")).RH_SWEEP_TIME, "00:10");
  } finally {
    temp.cleanup();
  }
});

test("a project uses the light image by default and the Obsidian add-on with --obsidian", () => {
  const temp = tempDir();
  try {
    assert.equal(run(["light", "--base", temp.dir]).status, 0);
    assert.equal(run(["notes", "--base", temp.dir, "--obsidian"]).status, 0);
    const light = readFileSync(join(temp.dir, "light/docker-compose.yml"), "utf8");
    const notes = readFileSync(join(temp.dir, "notes/docker-compose.yml"), "utf8");
    assert.match(light, /image: research-hub:latest/);
    assert.match(light, /target: lite/);
    assert.match(notes, /image: research-hub:obsidian/);
    assert.match(notes, /target: obsidian/);
    assert.equal(env(join(temp.dir, "light/.env")).RH_KB_VIEWER, "off");
    assert.equal(env(join(temp.dir, "notes/.env")).RH_KB_VIEWER, "on");
  } finally {
    temp.cleanup();
  }
});
