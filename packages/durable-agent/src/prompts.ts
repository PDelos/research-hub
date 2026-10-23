// Prompts live in apps/dna-server-api/prompt_engineering/agents/<agent>/{SYSTEM_PROMPT.md, USER_PROMPT_<name>.md}. Never inline.
// Variables are {{name}}; a missing variable throws, and every user prompt must carry a Definition Of Done.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

const VAR = /\{\{\s*(\w+)\s*\}\}/g;

export function promptVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]))].sort();
}

export function renderTemplate(
  text: string,
  vars: Record<string, unknown>,
  label = "prompt",
): string {
  const missing = promptVariables(text).filter((name) => vars[name] === undefined);
  if (missing.length) throw new PromptError(`${label} is missing variables: ${missing.join(", ")}`);
  return text.replace(VAR, (_, name: string) => {
    const value = vars[name];
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}

export function assertDefinitionOfDone(text: string, label: string): void {
  if (!/^##\s+Definition Of Done\s*$/m.test(text))
    throw new PromptError(`${label} has no "## Definition Of Done" section`);
}

export function readPrompt(root: string, agent: string, file: string): string {
  const path = join(root, agent, file);
  const text = readFileSync(path, "utf8");
  if (file.startsWith("USER_PROMPT_")) assertDefinitionOfDone(text, `${agent}/${file}`);
  return text;
}

export function loadPrompt(
  root: string,
  agent: string,
  file: string,
  vars: Record<string, unknown>,
): string {
  return renderTemplate(readPrompt(root, agent, file), vars, `${agent}/${file}`).trim();
}

export function listPrompts(root: string): { agent: string; file: string; path: string }[] {
  return readdirSync(root)
    .filter((agent) => statSync(join(root, agent)).isDirectory())
    .flatMap((agent) =>
      readdirSync(join(root, agent))
        .filter((file) => file.endsWith(".md"))
        .map((file) => ({ agent, file, path: join(root, agent, file) })),
    );
}
