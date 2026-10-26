// Built-in plugin rh.desk: the research desk agent. Its tool allow-list is read at every call: the v0 desk tools,
// minus any whose declaring plugin is not available (so disabling a plugin takes its tools away without a restart).
import type { Extension } from "@earendil-works/pi-durable";
import { createAgents, DESK_TOOLS, type Agents } from "../../src/agents.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";

export interface DeskExports {
  createAgents(options: { extra: Extension[]; separate: Extension[]; deskTools?: readonly string[] }): Agents;
  /** The tools the desk may call right now. */
  deskTools(): readonly string[];
}

export function activate(context: PluginContext): DeskExports {
  const host = hostOf(context);
  const { contributions } = host.services;
  const deskTools = () => {
    const declared = contributions.declaredChatTools();
    const available = new Set(contributions.chatTools({ desk: true }).map((t) => t.name));
    // Tools no plugin declares (added by tests or extensions) keep v0 behavior: allowed when listed.
    return DESK_TOOLS.filter((name) => !declared.has(name) || available.has(name));
  };
  return {
    deskTools,
    createAgents: ({ extra, separate, deskTools: fixed }) =>
      createAgents({
        promptsDir: host.options.promptsDir,
        projectName: host.name,
        extra,
        separate,
        deskTools: fixed ?? deskTools,
      }),
  };
}
