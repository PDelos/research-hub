/**
 * Jev commands live as JSON in apps/rh-server/prompt_engineering/jev/<name>/command.json, never inline.
 *
 *   { name, version, description, model?, state, questions, policy, each? }
 *
 * `state` and `questions` are templates. A string that is exactly "{{var}}" becomes the
 * variable's JSON value (objects and arrays stay structured). Any other "{{var}}" inside a
 * string is interpolated as text. `each: { over: "claims", as: "claim" }` repeats every
 * question once per element of vars.claims, binding vars.claim and suffixing ids with _<i>.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SystemOneResult } from "./client.ts";
import {
  InputTooLargeError,
  inputBytes,
  MAX_INPUT_BYTES,
  type Questions,
  type State,
  validateQuestions,
} from "./types.ts";

export interface JevCommand {
  name: string;
  version: number;
  description: string;
  model?: string;
  state: unknown;
  questions: Record<string, unknown>;
  policy: Record<string, unknown>;
  each?: { over: string; as: string };
}

export interface RenderedCommand {
  name: string;
  version: number;
  model?: string;
  state: State;
  questions: Questions;
  policy: Record<string, unknown>;
}

export type Vars = Record<string, unknown>;

export type Decide = (
  state: State,
  questions: Questions,
  opts?: { model?: string; signal?: AbortSignal },
) => Promise<SystemOneResult>;

export class TemplateError extends Error {
  readonly missing: string[];
  constructor(command: string, missing: string[]) {
    super(`Jev command "${command}" is missing variables: ${missing.join(", ")}`);
    this.name = "TemplateError";
    this.missing = missing;
  }
}

const WHOLE = /^\{\{\s*([\w.]+)\s*\}\}$/;
const PART = /\{\{\s*([\w.]+)\s*\}\}/g;

export function listCommands(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

export function loadCommand(name: string, dir: string): JevCommand {
  const file = join(dir, name, "command.json");
  const cmd = JSON.parse(readFileSync(file, "utf8")) as JevCommand;
  if (cmd.name !== name) throw new Error(`${file}: name "${cmd.name}" does not match its folder "${name}"`);
  if (!Number.isInteger(cmd.version) || cmd.version < 1) throw new Error(`${file}: version must be a positive integer`);
  if (!cmd.questions || typeof cmd.questions !== "object") throw new Error(`${file}: questions must be an object`);
  cmd.policy ??= {};
  return cmd;
}

/** Every variable name a command references. */
export function commandVariables(cmd: JevCommand): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") for (const m of value.matchAll(PART)) found.add(m[1]);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(cmd.state);
  walk(cmd.questions);
  if (cmd.each) {
    found.delete(cmd.each.as);
    found.add(cmd.each.over);
  }
  return [...found].sort();
}

function fill(value: unknown, vars: Vars, missing: Set<string>): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE);
    if (whole) {
      if (vars[whole[1]] === undefined) missing.add(whole[1]);
      return vars[whole[1]];
    }
    return value.replace(PART, (_, key: string) => {
      const v = vars[key];
      if (v === undefined) {
        missing.add(key);
        return "";
      }
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars, missing)]));
  }
  return value;
}

export function renderCommand(cmd: JevCommand, vars: Vars): RenderedCommand {
  const missing = new Set<string>();
  const state = fill(cmd.state, vars, missing) as State;
  let questions: Record<string, unknown>;
  if (cmd.each) {
    const items = vars[cmd.each.over];
    if (!Array.isArray(items) || items.length === 0) {
      missing.add(cmd.each.over);
      questions = {};
    } else {
      questions = {};
      items.forEach((item, i) => {
        const scoped = fill(cmd.questions, { ...vars, [cmd.each!.as]: item, index: i }, missing) as Record<
          string,
          unknown
        >;
        for (const [id, q] of Object.entries(scoped)) questions[`${id}_${i}`] = q;
      });
    }
  } else {
    questions = fill(cmd.questions, vars, missing) as Record<string, unknown>;
  }
  if (missing.size) throw new TemplateError(cmd.name, [...missing].sort());
  validateQuestions(questions);
  return {
    name: cmd.name,
    version: cmd.version,
    model: cmd.model,
    state,
    questions,
    policy: cmd.policy,
  };
}

/** Render and decide in one step. */
export async function runCommand(
  cmd: JevCommand,
  vars: Vars,
  decide: Decide,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ rendered: RenderedCommand; result: SystemOneResult }> {
  const rendered = renderCommand(cmd, vars);
  const bytes = inputBytes({ state: rendered.state, questions: rendered.questions });
  if (bytes > MAX_INPUT_BYTES) throw new InputTooLargeError(bytes, cmd.name);
  const result = await decide(rendered.state, rendered.questions, {
    model: opts.model ?? rendered.model,
    signal: opts.signal,
  });
  return { rendered, result };
}
