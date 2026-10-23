// The project's agents as pi-durable extensions: research-desk, the root agent each project chats with.
// allowOnly blocks any tool call outside its list.
import { join } from "node:path";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { allowOnly, loadPrompt } from "@rh/durable-agent";

/** Tools the research desk may call. */
export const DESK_TOOLS: readonly string[] = ["search_papers", "recent_cards", "judge_card", "search_kb", "query_kb"];

export interface Agents {
  desk: Extension;
  all: Extension[];
  defaults: Extension[];
}

export function createAgents(options: {
  promptsDir: string;
  projectName: string;
  extra?: Extension[];
  /** Installed in the registry but not selected by the chat conversation (e.g. the charter writer). */
  separate?: Extension[];
  deskTools?: readonly string[];
}): Agents {
  const prompt = loadPrompt(join(options.promptsDir, "agents"), "research-desk", "SYSTEM_PROMPT.md", {
    project_name: options.projectName,
  });
  const desk = defineExtension({
    name: "research-desk",
    sections: [section("research-desk", () => prompt, { tag: false })],
    hooks: [allowOnly("research-desk", options.deskTools ?? DESK_TOOLS)],
  });
  const extra = options.extra ?? [];
  return { desk, all: [desk, ...extra, ...(options.separate ?? [])], defaults: [desk, ...extra] };
}
