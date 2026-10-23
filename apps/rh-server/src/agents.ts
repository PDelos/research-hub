// The project's agents as pi-durable extensions. v0.0 has one: research-desk, the root agent each project chats
// with. It has no tools yet; allowOnly blocks any tool call outside its (empty) list.
import { join } from "node:path";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { allowOnly, loadPrompt } from "@rh/durable-agent";

/** Tools the research desk may call. Empty until the paper layers add theirs. */
export const DESK_TOOLS: readonly string[] = [];

export interface Agents {
  desk: Extension;
  all: Extension[];
  defaults: Extension[];
}

export function createAgents(options: {
  promptsDir: string;
  projectName: string;
  extra?: Extension[];
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
  return { desk, all: [desk, ...extra], defaults: [desk, ...extra] };
}
