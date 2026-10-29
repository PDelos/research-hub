// Built-in plugin rh.desk: the research desk agent. Its tool allow-list is read at every call: the v0 desk tools,
// minus any whose declaring plugin is not available (so disabling a plugin takes its tools away without a restart).
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { defineAppTool, once, toolError, toolText } from "@rh/durable-agent";
import { createAgents, DESK_TOOLS, type Agents } from "../../src/agents.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";

export interface DeskExports {
  createAgents(options: { extra: Extension[]; separate: Extension[]; deskTools?: readonly string[] }): Agents;
  /** The tools the desk may call right now. */
  deskTools(): readonly string[];
  /**
   * The chat tools external plugins offer the desk, as agent tools that call the plugin (its process answers).
   * Built when the agent runtime opens: a plugin installed later offers its tools after the next start.
   */
  pluginTools(): Extension;
}

export function activate(context: PluginContext): DeskExports {
  const host = hostOf(context);
  const { contributions } = host.services;
  const deskTools = () => {
    const declared = contributions.declaredChatTools();
    const available = new Set(contributions.chatTools({ desk: true }).map((t) => t.name));
    // The v0 list (tools no plugin declares keep v0 behavior), then every tool an available plugin offers the desk.
    return [...new Set([...DESK_TOOLS.filter((name) => !declared.has(name) || available.has(name)), ...available])];
  };
  const pluginTools = () =>
    defineExtension({
      name: "plugin-tools",
      tools: contributions
        .chatTools({ desk: true })
        .filter((t) => !t.builtin)
        .map((t) =>
          defineAppTool({
            name: t.name,
            description: `${t.description} (from the ${t.pluginId} plugin)`,
            returns: "Text: the plugin's answer.",
            parameters: Type.Unsafe<Record<string, unknown>>(t.parameters),
            execute: async (args, api, toolContext) => {
              // Once per call: a replay after a crash returns the stored answer instead of calling the plugin again.
              const answer = JSON.parse(
                await once<string>(api, "plugin-tool", toolContext, async () => {
                  try {
                    const value = await contributions.callChatTool(t.name, args);
                    return JSON.stringify({ text: typeof value === "string" ? value : JSON.stringify(value) });
                  } catch (error) {
                    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
                  }
                }),
              ) as { text?: string; error?: string };
              return answer.error ? toolError(`${t.name} failed: ${answer.error}`) : toolText(answer.text ?? "");
            },
          }),
        ),
    });
  return {
    deskTools,
    pluginTools,
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
