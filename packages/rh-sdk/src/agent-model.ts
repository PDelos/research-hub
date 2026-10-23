// Client-side agent reducer: consumes agent.snapshot and agent.batch frames for one conversation and exposes plain
// state plus change notifications, so Vue, the TUI or a test can render it without knowing the wire.
import type { Frame } from "./frames.ts";
import { toTranscript, type LiveTool, type TranscriptItem } from "./transcript.ts";
import type {
  InboxItem,
  WireAgentEvent,
  WireAgentState,
  WireAssistantBlock,
  WireAssistantMessage,
  WireEntry,
  WireMessageChange,
  WireSnapshotEvent,
  WireUsageState,
} from "./wire.ts";

type Listener = () => void;

export class Emitter {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  protected emit() {
    for (const fn of this.listeners) fn();
  }
}

// ---------------------------------------------------------------- agent

export interface AgentViewState {
  /** Normalized transcript of the active context plus live generation and tools. */
  items: TranscriptItem[];
  /** Committed entries of the active context, ordered by id. */
  entries: WireEntry[];
  /** True between run_start and run_end (snapshot: `run` present). */
  running: boolean;
  generating: boolean;
  inbox: InboxItem[];
  agent: WireAgentState;
  usage: WireUsageState;
  retry?: { at: number; error: string };
  compactions: number[];
  notices: string[];
  /** Set once the first snapshot arrives. */
  ready: boolean;
}

const emptyAgentState = (): AgentViewState => ({
  items: [],
  entries: [],
  running: false,
  generating: false,
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
  compactions: [],
  notices: [],
  ready: false,
});

function setPath(
  target: Record<string | number, unknown>,
  path: readonly (string | number)[],
  delta: string,
) {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof node[key] !== "object" || node[key] === null)
      node[key] = typeof path[i + 1] === "number" ? [] : {};
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  node[last] = String(node[last] ?? "") + delta;
}

export function applyMessageChange(
  message: WireAssistantMessage,
  change: WireMessageChange,
): WireAssistantMessage {
  if (change.type === "message") return structuredClone(change.message);
  const content = [...message.content] as WireAssistantBlock[];
  const i = change.contentIndex;
  if (change.type === "block" || change.type.endsWith("_start")) {
    content[i] = structuredClone((change as { block: WireAssistantBlock }).block);
  } else if (change.type === "text_delta") {
    const block = content[i];
    content[i] = { type: "text", text: (block?.type === "text" ? block.text : "") + change.delta };
  } else if (change.type === "thinking_delta") {
    const block = content[i];
    content[i] = {
      type: "thinking",
      thinking: (block?.type === "thinking" ? block.thinking : "") + change.delta,
    };
  } else if (change.type === "toolcall_delta") {
    const block = structuredClone(
      content[i] ?? { type: "toolCall", id: "", name: "", arguments: {} },
    );
    setPath(block as unknown as Record<string, unknown>, change.path, change.delta);
    content[i] = block;
  }
  return { ...message, content };
}

export class AgentModel extends Emitter {
  state: AgentViewState = emptyAgentState();
  private entries = new Map<number, WireEntry>();
  private live?: WireAssistantMessage;
  private tools = new Map<string, LiveTool>();

  /** The conversation this model follows; frames for other conversations are ignored. */
  constructor(public conversationId?: number) {
    super();
  }

  /** Apply one stream frame; returns true when state changed. */
  apply(frame: Frame): boolean {
    if (frame.type === "hello" && this.conversationId === undefined)
      this.conversationId = frame.mainConversationId;
    if (
      (frame.type === "agent.snapshot" || frame.type === "agent.batch") &&
      frame.conversationId !== this.conversationId
    )
      return false;
    switch (frame.type) {
      case "agent.snapshot":
        this.reset(frame.snapshot);
        this.state.inbox = frame.snapshot.inbox.map((q) => ({
          id: q.id,
          mode: q.mode as InboxItem["mode"],
        }));
        break;
      case "agent.batch":
        for (const event of frame.events) this.event(event);
        break;
      default:
        return false;
    }
    this.rebuild();
    this.emit();
    return true;
  }

  /** Re-render without new data (for example after a UI toggle). */
  touch() {
    this.emit();
  }

  clear() {
    this.entries.clear();
    this.tools.clear();
    this.live = undefined;
    this.state = emptyAgentState();
    this.emit();
  }

  private rebuild() {
    const entries = [...this.entries.values()].sort((a, b) => a.id - b.id);
    this.state.entries = entries;
    this.state.generating = !!this.live;
    this.state.items = toTranscript(entries, this.live, this.tools);
  }

  private reset(snapshot: WireSnapshotEvent) {
    this.entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    this.live = snapshot.generation?.message
      ? structuredClone(snapshot.generation.message)
      : undefined;
    this.tools = new Map(
      snapshot.tools.map((slot) => [
        slot.callId,
        { name: slot.name, status: slot.status, output: slot.output ?? "" },
      ]),
    );
    this.state.running = !!snapshot.run;
    this.state.agent = snapshot.agent;
    this.state.usage = snapshot.usage;
    this.state.retry = snapshot.generation?.retry;
    this.state.compactions = snapshot.compactions.map((c) => c.taskId);
    this.state.ready = true;
  }

  /** Store a committed entry. Resets (sent as message_end) and compactions start a new context head. */
  private commit(entry: WireEntry) {
    this.entries.set(entry.id, entry);
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") {
      const head = entry.head ?? entry.id;
      for (const id of this.entries.keys()) if (id < head) this.entries.delete(id);
    }
  }

  private event(event: WireAgentEvent) {
    switch (event.type) {
      case "snapshot":
        return this.reset(event);
      case "run_start":
        this.state.running = true;
        return;
      case "run_end":
        this.state.running = false;
        this.live = undefined;
        return;
      case "message_start":
        if (event.message.role === "assistant")
          this.live = structuredClone(event.message as WireAssistantMessage);
        return;
      case "message_update":
        if (!this.live)
          this.live = {
            role: "assistant",
            content: [],
            provider: "",
            model: "",
            usage: event.usage,
            stopReason: "pending",
          };
        for (const change of event.changes) this.live = applyMessageChange(this.live, change);
        this.live = { ...this.live, usage: event.usage };
        return;
      case "message_end":
        this.live = undefined;
        return this.commit(event.entry);
      case "entry_appended":
        return this.commit(event.entry);
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          name: event.toolName,
          status: "running",
          output: "",
          args: event.args,
        });
        return;
      case "tool_execution_update": {
        const tool = this.tools.get(event.toolCallId) ?? {
          name: event.toolName,
          status: "running" as const,
          output: "",
        };
        const output = event.output;
        if (output && "set" in output) tool.output = output.set;
        else if (output)
          tool.output = tool.output.slice(output.trimStart ?? 0) + (output.append ?? "");
        tool.status = "running";
        this.tools.set(event.toolCallId, tool);
        return;
      }
      case "inbox_update":
        this.state.inbox = event.items.map((q) => ({
          id: q.id,
          mode: q.mode as InboxItem["mode"],
        }));
        return;
      case "tool_execution_end":
        this.tools.delete(event.toolCallId);
        if (event.entry) this.entries.set(event.entry.id, event.entry);
        return;
      case "agent_changed":
        this.state.agent = event.agent;
        return;
      case "usage_changed":
        this.state.usage = event.usage;
        return;
      case "auto_retry_start":
        this.state.retry = { at: event.at, error: event.errorMessage };
        return;
      case "auto_retry_end":
        this.state.retry = undefined;
        return;
      case "compaction_start":
        if (!this.state.compactions.includes(event.taskId))
          this.state.compactions.push(event.taskId);
        return;
      case "compaction_end":
        this.state.compactions = this.state.compactions.filter((id) => id !== event.taskId);
        return;
      case "task_failed":
        this.state.notices = [
          ...this.state.notices.slice(-9),
          `${event.kind} failed: ${event.message}`,
        ];
        return;
      default:
        return;
    }
  }
}
