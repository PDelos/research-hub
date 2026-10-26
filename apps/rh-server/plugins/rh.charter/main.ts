// Built-in plugin rh.charter: the brief, scoping questions, versioned charters, the project state derived from them,
// and the charter writer agent.
import { Brief, Charters, ProjectState, ScopingQuestions } from "../../src/charter.ts";
import { CharterWriter } from "../../src/charter-writer.ts";
import { hostOf, type AgentHooks } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { ProviderExports } from "../rh.provider-openrouter/main.ts";

export interface CharterExports extends AgentHooks {
  brief: Brief;
  charters: Charters;
  questions: ScopingQuestions;
  state: ProjectState;
  charterWriter: CharterWriter;
}

export function activate(context: PluginContext): CharterExports {
  const host = hostOf(context);
  const { catalog } = context.exports["rh.provider-openrouter"] as ProviderExports;
  const brief = new Brief(host.dir);
  const charters = new Charters(host.db);
  const questions = new ScopingQuestions(host.db);
  const state = new ProjectState(host.settings, brief, charters);
  const charterWriter = new CharterWriter({
    settings: host.settings,
    charters,
    questions,
    brief,
    catalog,
    promptsDir: host.options.promptsDir,
    log: host.log,
    observe: host.observe,
  });
  return {
    brief,
    charters,
    questions,
    state,
    charterWriter,
    separateExtensions: [charterWriter.extension],
    attach: (harness, ctx) => charterWriter.attach(harness, ctx),
  };
}
