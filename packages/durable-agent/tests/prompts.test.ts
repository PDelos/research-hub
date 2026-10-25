import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertDefinitionOfDone, listPrompts, PromptError, promptVariables, renderTemplate } from "../src/prompts.ts";

const ROOT = join(import.meta.dirname, "../../..");
const AGENTS = join(ROOT, "apps/rh-server/prompt_engineering/agents");

test("renderTemplate fills variables and names every missing one", () => {
  assert.equal(renderTemplate("Hi {{ name }}, {{n}}", { name: "Dan", n: 3 }), "Hi Dan, 3");
  assert.throws(
    () => renderTemplate("{{a}} {{b}}", { a: 1 }, "x"),
    (e: unknown) => e instanceof PromptError && /missing variables: b/.test(e.message),
  );
  assert.deepEqual(promptVariables("{{b}} {{a}} {{b}}"), ["a", "b"]);
  assert.throws(() => assertDefinitionOfDone("# Purpose\nNo done", "x"), /Definition Of Done/);
});

test("every user prompt has a Definition Of Done and every agent has a system prompt", () => {
  const prompts = listPrompts(AGENTS);
  const agents = new Set(prompts.map((p) => p.agent));
  for (const agent of agents)
    assert.ok(existsSync(join(AGENTS, agent, "SYSTEM_PROMPT.md")), `${agent} has SYSTEM_PROMPT.md`);
  for (const p of prompts.filter((p) => p.file.startsWith("USER_PROMPT_"))) {
    assert.doesNotThrow(() => assertDefinitionOfDone(readFileSync(p.path, "utf8"), `${p.agent}/${p.file}`));
  }
  for (const p of prompts) assert.match(p.file, /^(SYSTEM_PROMPT|USER_PROMPT_[a-z_]+)\.md$/, p.path);
});

test("no TypeScript source inlines a prompt", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "tests" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|vue)$/.test(name)) {
        const text = readFileSync(path, "utf8");
        if (/Definition Of Done|^\s*["'`]You are (an?|the) /m.test(text) || /`[^`]*\n##\s+\w/.test(text))
          offenders.push(path);
      }
    }
  };
  walk(join(ROOT, "apps"));
  assert.deepEqual(
    offenders.filter((p) => !p.endsWith("prompts.ts")),
    [],
  );
});
