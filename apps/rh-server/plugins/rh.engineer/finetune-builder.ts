// The engineer's fine-tuned-embedder builder (spec engineer: Fine-tuned embedder on Kaggle; design v1-8 D4–D6):
// training data from the user's judgments, a free GPU run on Kaggle, the model downloaded into the project, the
// embedder preset on it through the local embedder, and a proposal only when it beats the active embedder.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Charter } from "../../src/charter.ts";
import type { Db } from "../../src/db.ts";
import { KaggleRunner, kaggleCredentials } from "../../src/engineer/kaggle.ts";
import { MIN_PAIRS, trainingData, trainingScript, type TrainingData } from "../../src/engineer/finetune.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { HarnessExports } from "../rh.harness/main.ts";
import type { LocalEmbedderExports } from "../rh.embedder-local/main.ts";
import type { Builder } from "./main.ts";

export const WIN_MARGIN = 0.02;

interface FinetuneDeps {
  db: Db;
  rh: RhApi;
  dataDir: string;
  project: string;
  charter: () => Charter | undefined;
  harness: HarnessExports;
  local: () => Promise<LocalEmbedderExports>;
}

type Say = (text: string) => void;
type BenchmarkRun = Awaited<ReturnType<HarnessExports["runBenchmark"]>>;

/** Pairs from the user's judgments; too few liked papers matched to questions stops the build. */
function enoughTrainingData(deps: FinetuneDeps): TrainingData {
  const charter = deps.charter();
  if (!charter) throw new Error("there is no approved charter");
  const data = trainingData(deps.db, charter);
  if (data.pairs.length < MIN_PAIRS)
    throw new Error(
      `fine-tuning needs at least ${MIN_PAIRS} liked papers matched to your questions; there are ${data.pairs.length}`,
    );
  return data;
}

/** Train on Kaggle's free GPU and return the files of the model/ folder it wrote. */
async function trainOnKaggle(
  deps: FinetuneDeps,
  ideaId: number,
  data: TrainingData,
  { credentials, say }: { credentials: ReturnType<typeof kaggleCredentials>; say: Say },
) {
  const runner = new KaggleRunner({
    request: (url, init) =>
      deps.rh.http.request(url, {
        ...init,
        method: init.method as "POST" | "GET" | undefined,
        timeoutMs: 120_000,
        attempts: 2,
      }),
    credentials,
    pollMs: Number(process.env.RH_KAGGLE_POLL_MS ?? 60_000),
    onStatus: (status) => say(`Kaggle: ${status.toLowerCase()}.`),
  });
  const slug = `rh-${deps.project}-idea-${ideaId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 50);
  const pushed = await runner.push(
    slug,
    `Research Hub ${deps.project}: embedder fine-tune ${ideaId}`,
    trainingScript(data),
  );
  say(`Training on Kaggle's free GPU: ${pushed.url ?? pushed.ref}.`);
  await runner.wait(slug);
  const { files } = await runner.output(slug);
  const modelFiles = files.filter((f) => f.fileName.startsWith("model/"));
  if (!modelFiles.length) throw new Error("the Kaggle run finished without a model/ folder");
  return modelFiles;
}

async function download(deps: FinetuneDeps, files: { fileName: string; url: string }[], modelDir: string) {
  for (const file of files) {
    const response = await deps.rh.http.request(file.url, { timeoutMs: 600_000, attempts: 2 });
    if (!response.ok) throw new Error(`downloading ${file.fileName}: HTTP ${response.status}`);
    const target = join(modelDir, file.fileName.slice("model/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
  }
}

const starsOf = (run: BenchmarkRun) => run.result.tasks.find((t) => t.task === "your-stars")?.value ?? null;

/** The fine-tuned model wins by WIN_MARGIN on the mean and is not worse on the user's stars; otherwise it throws. */
function requireWin(active: BenchmarkRun, candidate: BenchmarkRun): void {
  const gain = (candidate.result.value ?? 0) - (active.result.value ?? 0);
  const stars = { candidate: starsOf(candidate), active: starsOf(active) };
  const starsOk = stars.candidate === null || stars.active === null || stars.candidate >= stars.active;
  if (candidate.result.value === null || active.result.value === null || gain < WIN_MARGIN || !starsOk)
    throw new Error(
      `the fine-tuned model did not beat the active embedder by ${WIN_MARGIN}: mean nDCG@10 ${(candidate.result.value ?? 0).toFixed(3)} vs ${(active.result.value ?? 0).toFixed(3)}${starsOk ? "" : " (and it is worse on your stars)"}`,
    );
}

export function finetuneBuilder(deps: FinetuneDeps): Builder {
  return async ({ idea, say, dir }) => {
    // Missing Kaggle credentials stop the build first: the message says what to set.
    const credentials = kaggleCredentials((name) => deps.rh.secrets.get(name));
    const local = await deps.local();
    const availability = local.available();
    if (!availability.ok) throw new Error(`the fine-tuned model could not run here: ${availability.reason}`);
    const data = enoughTrainingData(deps);
    say(`Training data: ${data.pairs.length} question–paper pairs and ${data.negatives.length} disliked papers.`);
    const modelFiles = await trainOnKaggle(deps, idea.id, data, { credentials, say });
    const modelDir = join(dir, "model");
    await download(deps, modelFiles, modelDir);
    const model = relative(deps.dataDir, modelDir);
    say(`Downloaded the model (${modelFiles.length} files) to ${model}.`);
    const dims = await local.probeDims(model);
    say("Running the embedder preset on the active embedder and on the fine-tuned model.");
    const active = await deps.harness.runBenchmark("embedder");
    const candidate = await deps.harness.runBenchmark("embedder", { provider: "local", model });
    requireWin(active, candidate);
    say(
      `Better: mean nDCG@10 ${candidate.result.value!.toFixed(3)} vs ${active.result.value!.toFixed(3)}. Enable it to switch the embedder.`,
    );
    return {
      numbers: {
        model,
        dims,
        mean: candidate.result.value,
        activeMean: active.result.value,
        activeModel: active.candidate.model,
        yourStars: starsOf(candidate),
        activeYourStars: starsOf(active),
      },
    };
  };
}
