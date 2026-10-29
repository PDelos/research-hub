// The engineer's fine-tuned-embedder builder (spec engineer: Fine-tuned embedder on Kaggle; design v1-8 D4–D6):
// training data from the user's judgments, a free GPU run on Kaggle, the model downloaded into the project, the
// embedder preset on it through the local embedder, and a proposal only when it beats the active embedder.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Charter } from "../../src/charter.ts";
import type { Db } from "../../src/db.ts";
import { KaggleRunner, kaggleCredentials } from "../../src/engineer/kaggle.ts";
import { MIN_PAIRS, trainingData, trainingScript } from "../../src/engineer/finetune.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { HarnessExports } from "../rh.harness/main.ts";
import type { LocalEmbedderExports } from "../rh.embedder-local/main.ts";
import type { Builder } from "./main.ts";

export const WIN_MARGIN = 0.02;

export function finetuneBuilder(deps: {
  db: Db;
  rh: RhApi;
  dataDir: string;
  project: string;
  charter: () => Charter | undefined;
  harness: HarnessExports;
  local: () => Promise<LocalEmbedderExports>;
}): Builder {
  return async ({ idea, say, dir }) => {
    const credentials = kaggleCredentials((name) => deps.rh.secrets.get(name));
    const local = await deps.local();
    const availability = local.available();
    if (!availability.ok) throw new Error(`the fine-tuned model could not run here: ${availability.reason}`);
    const charter = deps.charter();
    if (!charter) throw new Error("there is no approved charter");
    const data = trainingData(deps.db, charter);
    if (data.pairs.length < MIN_PAIRS)
      throw new Error(
        `fine-tuning needs at least ${MIN_PAIRS} liked papers matched to your questions; there are ${data.pairs.length}`,
      );
    say(`Training data: ${data.pairs.length} question–paper pairs and ${data.negatives.length} disliked papers.`);
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
    const slug = `rh-${deps.project}-idea-${idea.id}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 50);
    const pushed = await runner.push(
      slug,
      `Research Hub ${deps.project}: embedder fine-tune ${idea.id}`,
      trainingScript(data),
    );
    say(`Training on Kaggle's free GPU: ${pushed.url ?? pushed.ref}.`);
    await runner.wait(slug);
    const { files } = await runner.output(slug);
    const modelFiles = files.filter((f) => f.fileName.startsWith("model/"));
    if (!modelFiles.length) throw new Error("the Kaggle run finished without a model/ folder");
    const modelDir = join(dir, "model");
    for (const f of modelFiles) {
      const res = await deps.rh.http.request(f.url, { timeoutMs: 600_000, attempts: 2 });
      if (!res.ok) throw new Error(`downloading ${f.fileName}: HTTP ${res.status}`);
      const target = join(modelDir, f.fileName.slice("model/".length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Uint8Array(await res.arrayBuffer()));
    }
    const model = relative(deps.dataDir, modelDir);
    say(`Downloaded the model (${modelFiles.length} files) to ${model}.`);
    const dims = await local.probeDims(model);
    say("Running the embedder preset on the active embedder and on the fine-tuned model.");
    const active = await deps.harness.runBenchmark("embedder");
    const candidate = await deps.harness.runBenchmark("embedder", { provider: "local", model });
    const stars = (r: typeof active) => r.result.tasks.find((t) => t.task === "your-stars")?.value ?? null;
    const gain = (candidate.result.value ?? 0) - (active.result.value ?? 0);
    const starsOk = stars(candidate) === null || stars(active) === null || stars(candidate)! >= stars(active)!;
    const numbers = {
      model,
      dims,
      mean: candidate.result.value,
      activeMean: active.result.value,
      activeModel: active.candidate.model,
      yourStars: stars(candidate),
      activeYourStars: stars(active),
    };
    if (candidate.result.value === null || active.result.value === null || gain < WIN_MARGIN || !starsOk)
      throw new Error(
        `the fine-tuned model did not beat the active embedder by ${WIN_MARGIN}: mean nDCG@10 ${(candidate.result.value ?? 0).toFixed(3)} vs ${(active.result.value ?? 0).toFixed(3)}${starsOk ? "" : " (and it is worse on your stars)"}`,
      );
    say(
      `Better: mean nDCG@10 ${candidate.result.value!.toFixed(3)} vs ${active.result.value!.toFixed(3)}. Enable it to switch the embedder.`,
    );
    return { numbers };
  };
}
