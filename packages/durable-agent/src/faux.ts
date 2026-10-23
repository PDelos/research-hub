// A scripted faux model: free, deterministic agent runs for tests and offline demos.
// Rules see the request (system sections, messages, the last user text, tool results) and return the next
// assistant message, or undefined to let the next rule try. The last resort echoes the user.
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { FAUX_MODEL, FAUX_WINDOW } from "./models.ts";

export interface FauxTurn {
  messages: Message[];
  /** Every system section seen so far, by name. */
  sections: Record<string, string>;
  /** System text (leading message content plus sections). */
  system: string;
  lastUser: string;
  last: Message | undefined;
  /** Tool results since the last user message, oldest first. */
  results: { name: string; text: string; isError: boolean }[];
  /** Assistant tool calls since the last user message, oldest first. */
  calls: { name: string; arguments: Record<string, unknown> }[];
}

export type FauxRule = (turn: FauxTurn) => AssistantMessage | undefined;

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("")
      : "";

export function readTurn(messages: Message[]): FauxTurn {
  const sections: Record<string, string> = {};
  let system = "";
  for (const m of messages) {
    if (m.role !== "system") continue;
    system += textOf(m.content);
    for (const [key, value] of Object.entries(m.sections ?? {})) {
      if (value === null) delete sections[key];
      else sections[key] = value;
    }
  }
  system += Object.values(sections).join("\n");
  let lastUserIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUserIndex = i;
  });
  const since = messages.slice(lastUserIndex + 1);
  return {
    messages,
    sections,
    system,
    lastUser: lastUserIndex >= 0 ? textOf(messages[lastUserIndex].content).trim() : "",
    last: messages.at(-1),
    results: since
      .filter((m) => m.role === "toolResult")
      .map((m) => ({
        name: (m as { toolName: string }).toolName,
        text: textOf(m.content),
        isError: (m as { isError: boolean }).isError,
      })),
    calls: since.flatMap((m) =>
      m.role === "assistant"
        ? m.content
            .filter((b) => b.type === "toolCall")
            .map((b) => ({
              name: (b as { name: string }).name,
              arguments: (b as { arguments: Record<string, unknown> }).arguments,
            }))
        : [],
    ),
  };
}

export const say = (text: string): AssistantMessage => fauxAssistantMessage(fauxText(text));

export const call = (
  name: string,
  args: Record<string, unknown>,
  text = `Calling ${name}.`,
): AssistantMessage =>
  fauxAssistantMessage([fauxText(text), fauxToolCall(name, args as never)], {
    stopReason: "toolUse",
  });

export const calls = (
  list: { name: string; args: Record<string, unknown> }[],
  text = "Working.",
): AssistantMessage =>
  fauxAssistantMessage(
    [fauxText(text), ...list.map((c) => fauxToolCall(c.name, c.args as never))],
    { stopReason: "toolUse" },
  );

export function installScriptedFaux(
  models: MutableModels,
  rules: readonly FauxRule[],
  options: { tokensPerSecond?: number; modelIds?: readonly string[] } = {},
): FauxProviderHandle {
  const handle = fauxProvider({
    provider: "faux",
    // The configured model IDs are mirrored on the faux provider, so model switches work offline.
    models: [
      { id: FAUX_MODEL, name: "Faux Haiku", contextWindow: FAUX_WINDOW, maxTokens: 64_000 },
      ...(options.modelIds ?? [])
        .filter((id) => id !== FAUX_MODEL)
        .map((id) => ({ id, name: `${id} (faux)`, contextWindow: FAUX_WINDOW, maxTokens: 64_000 })),
    ],
    tokensPerSecond: options.tokensPerSecond ?? 2000,
  });
  const reply = (context: { messages: Message[] }): AssistantMessage => {
    handle.appendResponses([reply as never]);
    const turn = readTurn(context.messages);
    for (const rule of rules) {
      const message = rule(turn);
      if (message) return message;
    }
    return say(`Echo: ${turn.lastUser}`);
  };
  handle.setResponses([reply as never]);
  models.setProvider(handle.provider);
  return handle;
}
