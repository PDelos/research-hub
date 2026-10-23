// The model catalog: one model per job (desk, reader, review, chat), each an OpenRouter ID from configuration
// (RH_MODEL_DESK|READER|REVIEW|CHAT), so switching a model never needs a code change. Adapted from
// disler/pi-durable-news-agent, whose fixed 30-model list is replaced by configured jobs.
// The faux provider mirrors the configured IDs with a free deterministic model and a 1M window.
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelRef } from "@earendil-works/pi-durable";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
  cost: { input: number; output: number };
}

export const JOBS = ["desk", "reader", "review", "chat"] as const;
export type Job = (typeof JOBS)[number];

/** Defaults verified on OpenRouter 2026-10-22. */
export const DEFAULT_JOB_MODELS: Readonly<Record<Job, string>> = {
  desk: "anthropic/claude-haiku-5.5",
  reader: "anthropic/claude-haiku-5.5",
  review: "anthropic/claude-sonnet-5.5",
  chat: "anthropic/claude-haiku-5.5",
};
export const DEFAULT_MODEL = DEFAULT_JOB_MODELS.desk;
export const FAUX_WINDOW = 1_000_000;
export const FAUX_MODEL = "faux-haiku";

const ENV_KEYS: Readonly<Record<Job, string>> = {
  desk: "RH_MODEL_DESK",
  reader: "RH_MODEL_READER",
  review: "RH_MODEL_REVIEW",
  chat: "RH_MODEL_CHAT",
};

/** Each job's model from RH_MODEL_<JOB>, falling back to the defaults. */
export function jobModelsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Job, string> {
  const out = {} as Record<Job, string>;
  for (const job of JOBS) out[job] = env[ENV_KEYS[job]]?.trim() || DEFAULT_JOB_MODELS[job];
  return out;
}

export interface ModelCatalog {
  readonly models: MutableModels;
  readonly provider: "openrouter" | "faux";
  /** The configured model ID per job. */
  readonly jobs: Readonly<Record<Job, string>>;
  /** The desk model: what a new conversation starts with. */
  readonly defaultModel: ModelRef;
  /** The pi-durable model reference for a job. */
  forJob(job: Job): ModelRef;
  /** Every configured model (deduplicated), with window and price. */
  list(): ModelInfo[];
  /** A configured model ID to a pi-durable model reference; throws for anything else. */
  ref(id: string): ModelRef;
  info(id: string): ModelInfo | undefined;
}

export function createModelCatalog(options: {
  provider: "openrouter" | "faux";
  /** Installs the faux provider; receives every model ID it must answer for. */
  installFaux?: (models: MutableModels, modelIds: string[]) => void;
  jobs?: Partial<Record<Job, string>>;
}): ModelCatalog {
  const jobs = { ...DEFAULT_JOB_MODELS, ...options.jobs } as Record<Job, string>;
  const ids = [...new Set(JOBS.map((j) => jobs[j]))];
  const models = createModels();
  let list: () => ModelInfo[];
  let provider: "openrouter" | "faux";
  if (options.provider === "faux") {
    if (!options.installFaux) throw new Error("A faux catalog needs installFaux");
    options.installFaux(models, ids);
    provider = "faux";
    const all: ModelInfo[] = ids.map((id) => ({
      id,
      name: `${id} (faux)`,
      provider: "faux",
      contextWindow: FAUX_WINDOW,
      reasoning: false,
      cost: { input: 0, output: 0 },
    }));
    list = () => all;
  } else {
    const openrouter = openrouterProvider();
    models.setProvider(openrouter);
    const known = openrouter.getModels();
    const missing = ids.filter((id) => !known.some((m) => m.id === id));
    if (missing.length)
      throw new Error(
        `Configured model(s) not in pi-ai's OpenRouter list: ${missing.join(", ")}. Check RH_MODEL_* for typos or pick a listed model.`,
      );
    provider = "openrouter";
    list = () =>
      ids.map((id) => {
        const m = known.find((x) => x.id === id)!;
        return {
          id,
          name: m.name ?? id,
          provider: "openrouter",
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
          cost: { input: m.cost.input, output: m.cost.output },
        };
      });
  }
  const ref = (id: string): ModelRef => {
    if (!ids.includes(id))
      throw new Error(`Unknown model ${id}. Configured models: ${ids.join(", ")}.`);
    return { provider, modelId: id };
  };
  return {
    models,
    provider,
    jobs,
    defaultModel: ref(jobs.desk),
    forJob: (job) => ref(jobs[job]),
    list,
    ref,
    info: (id) => list().find((m) => m.id === id),
  };
}
