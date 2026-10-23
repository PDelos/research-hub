// App state: the agent transcript from the live stream (through @rh/sdk's AgentModel), plus info, runs and costs.
// The browser talks to /ui/v1, the server-side proxy that holds the token, so no token ever reaches this page.
import { reactive, shallowRef } from "vue";
import {
  AgentModel,
  HubClient,
  type AgentState,
  type CardGroup,
  type PrecisionPoint,
  type CharterView,
  type CostTotals,
  type Info,
  type ProjectOverview,
  type RunDetail,
  type RunSummary,
  type ScheduledRun,
  type ScheduleSettings,
  type SweepDetail,
  type SweepSummary,
} from "@rh/sdk";

export const client = new HubClient({ base: "/ui/v1" });

export const store = reactive({
  info: undefined as Info | undefined,
  agent: undefined as AgentState | undefined,
  totals: undefined as CostTotals | undefined,
  runs: [] as RunSummary[],
  run: undefined as RunDetail | undefined,
  project: undefined as ProjectOverview | undefined,
  charter: undefined as CharterView | undefined,
  schedule: undefined as ScheduleSettings | undefined,
  scheduledRuns: [] as ScheduledRun[],
  feed: [] as CardGroup[],
  sweep: undefined as SweepSummary | undefined,
  sweeps: [] as SweepSummary[],
  sweepDetail: undefined as SweepDetail | undefined,
  precision: [] as PrecisionPoint[],
  connected: false,
  error: "",
});

const model = new AgentModel();
export const transcript = shallowRef(model.state);
model.subscribe(() => (transcript.value = { ...model.state }));

/** Reload the project overview and charter; while a charter run is in progress, poll until it settles. */
let charterPoll: ReturnType<typeof setTimeout> | undefined;
export async function refreshProject() {
  try {
    const [project, charter] = await Promise.all([client.project(), client.charter()]);
    store.project = project;
    store.charter = charter;
    if (charter.run?.status === "running" && !charterPoll)
      charterPoll = setTimeout(() => {
        charterPoll = undefined;
        void refreshProject();
      }, 1500);
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }
}

export async function refreshFeed() {
  try {
    const [{ groups }, sweeps, precision] = await Promise.all([client.cards(), client.sweeps(20), client.precision()]);
    store.precision = precision;
    store.feed = groups;
    store.sweeps = sweeps;
    store.sweep = sweeps[0];
    if (store.sweepDetail) store.sweepDetail = await client.sweep(store.sweepDetail.id);
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }
}

export async function openSweep(id: number) {
  store.sweepDetail = store.sweepDetail?.id === id ? undefined : await client.sweep(id);
}

export async function refreshSchedule() {
  const [schedule, runs] = await Promise.all([client.schedule(), client.scheduledRuns()]);
  store.schedule = schedule;
  store.scheduledRuns = runs;
}

/** Run an action, then refresh the project; errors land in store.error and are rethrown for the caller. */
export async function act<T>(fn: () => Promise<T>): Promise<T> {
  try {
    store.error = "";
    return await fn();
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await refreshProject();
  }
}

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
    await Promise.all([refreshProject(), refreshSchedule()]);
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
        else if (frame.type === "cards") {
          store.sweep = frame.sweep ?? undefined;
          void refreshFeed();
          void refreshSchedule();
        }
        else if (frame.type === "usage") {
          store.totals = frame.totals;
          refreshRunsSoon();
          void refreshProject();
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
