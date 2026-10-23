// new-project.sh creates non-interfering projects: distinct ports, compose names and staggered sweep times (task 8.8).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers.ts";

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
  const t = tempDir();
  try {
    const a = run(["proteins", "--base", t.dir]);
    assert.equal(a.status, 0, a.stderr);
    const b = run(["genomics", "--base", t.dir]);
    assert.equal(b.status, 0, b.stderr);
    const ea = env(join(t.dir, "proteins/.env"));
    const eb = env(join(t.dir, "genomics/.env"));
    assert.equal(ea.RH_PROJECT_NAME, "proteins");
    assert.equal(eb.RH_PROJECT_NAME, "genomics");
    assert.notEqual(ea.RH_PUBLISH_PORT, eb.RH_PUBLISH_PORT);
    assert.equal((Number(eb.RH_PUBLISH_PORT) - 4850) % 10, 0);
    assert.equal(ea.RH_SWEEP_TIME, "06:00");
    assert.equal(eb.RH_SWEEP_TIME, "06:20");
    assert.notEqual(ea.RH_API_TOKEN, eb.RH_API_TOKEN);
    assert.match(ea.RH_API_TOKEN, /^[0-9a-f]{48}$/);
    assert.match(readFileSync(join(t.dir, "genomics/docker-compose.yml"), "utf8"), /^name: rh-genomics$/m);
    assert.ok(existsSync(join(t.dir, "genomics/data")));
    assert.equal(statSync(join(t.dir, "genomics/.env")).mode & 0o777, 0o600, ".env is private");
    assert.match(b.stdout, new RegExp(`http://genomics\\.localhost:${eb.RH_PUBLISH_PORT}`));
  } finally {
    t.cleanup();
  }
});

test("bad or existing names are refused", () => {
  const t = tempDir();
  try {
    assert.equal(run(["Bad Name", "--base", t.dir]).status, 2);
    assert.equal(run(["ok", "--base", t.dir]).status, 0);
    const again = run(["ok", "--base", t.dir]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
  } finally {
    t.cleanup();
  }
});

test("the sweep time wraps past midnight", () => {
  const t = tempDir();
  try {
    run(["late", "--base", t.dir]);
    const file = join(t.dir, "late/.env");
    const text = readFileSync(file, "utf8").replace(/^RH_SWEEP_TIME=.*$/m, "RH_SWEEP_TIME=23:50");
    writeFileSync(file, text);
    run(["next", "--base", t.dir]);
    assert.equal(env(join(t.dir, "next/.env")).RH_SWEEP_TIME, "00:10");
  } finally {
    t.cleanup();
  }
});
