// App state: the agent transcript from the live stream (through @rh/sdk's AgentModel), plus info, runs and costs.
// The browser talks to /ui/v1, the server-side proxy that holds the token, so no token ever reaches this page.
import { reactive, shallowRef } from "vue";
import { AgentModel, HubClient, type AgentState, type CostTotals, type Info, type RunDetail, type RunSummary } from "@rh/sdk";

export const client = new HubClient({ base: "/ui/v1" });

export const store = reactive({
  info: undefined as Info | undefined,
  agent: undefined as AgentState | undefined,
  totals: undefined as CostTotals | undefined,
  runs: [] as RunSummary[],
  run: undefined as RunDetail | undefined,
  connected: false,
  error: "",
});

const model = new AgentModel();
export const transcript = shallowRef(model.state);
model.subscribe(() => (transcript.value = { ...model.state }));

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function refreshRunsSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = undefined;
    try {
      store.runs = await client.runs();
      if (store.run) store.run = await client.run(store.run.id);
    } catch {}
  }, 400);
}

export async function connect() {
  try {
    store.info = await client.info();
    document.title = `${store.info.project} · Research Hub`;
  } catch (e) {
    store.error = String(e);
  }
  let delay = 500;
  for (;;) {
    try {
      for await (const frame of client.stream()) {
        store.connected = true;
        store.error = "";
        delay = 500;
        if (frame.type === "hello") {
          model.clear();
          model.conversationId = frame.mainConversationId;
        } else if (frame.type === "agent.state") store.agent = frame.state;
        else if (frame.type === "usage") {
          store.totals = frame.totals;
          refreshRunsSoon();
        } else model.apply(frame);
      }
    } catch (e) {
      store.error = e instanceof Error ? e.message : String(e);
    }
    store.connected = false;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 10_000);
  }
}

export async function send(text: string) {
  await client.send(text);
}

export async function openRun(id: number) {
  store.run = await client.run(id);
}
