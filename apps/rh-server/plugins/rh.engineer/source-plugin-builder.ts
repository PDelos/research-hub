// The engineer's paper-source builder (spec engineer; design v1-8): a model writes main.mjs for a free scholarly API,
// static checks reject unsafe code, then the plugin is installed in its sandbox and must answer a real search before
// it is kept, disabled, for the user to enable. Each failure goes back to the model as feedback.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_SYSTEM,
  codeProblems,
  contractProblems,
  extractMain,
  slug,
  sourceManifest,
} from "../../src/engineer/source-builder.ts";
import type { hostOf } from "../../src/kernel/builtin.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { SourceExports } from "../rh.papers/main.ts";
import { EngineerInvalid } from "./ideas.ts";
import type { Builder, Idea } from "./main.ts";

const SEARCH_TIMEOUT_MS = 60_000;

interface SourcePlan {
  idea: Idea;
  name: string;
  apiHost: string;
  sourceId: string;
  pluginId: string;
  folder: string;
}

interface SourceBuilderDeps {
  rh: RhApi;
  host: ReturnType<typeof hostOf>;
  charge: (ideaId: number, usd: number) => void;
  testQuery: () => string;
  maxAttempts: () => number;
}

/** The model's main.mjs, or why it was rejected before running. */
async function write(
  deps: SourceBuilderDeps,
  plan: SourcePlan,
  feedback: string,
): Promise<{ main?: string; problems: string[] }> {
  const api = plan.idea.assessment?.api ?? {};
  const retry = feedback ? `\n## The last attempt failed\n${feedback}\nFix exactly that.` : "";
  const answer = await deps.rh.models.complete({
    job: "review",
    system: BUILD_SYSTEM.replaceAll("<SOURCE_ID>", plan.sourceId),
    prompt: `## The API\nName: ${plan.name}\nBase URL: ${api.baseUrl}\nDocs: ${api.docsUrl ?? "(none)"}\nHost (the only one allowed): ${plan.apiHost}\n\n## Plan\n${plan.idea.assessment?.plan ?? ""}\n${retry}`,
    maxTokens: 4_000,
  });
  deps.charge(plan.idea.id, answer.costUsd);
  const main = extractMain(answer.text);
  if (!main)
    return {
      problems: [`no main.mjs in the answer (one fenced code block); it began: ${answer.text.slice(0, 160)}`],
    };
  return { main, problems: codeProblems(main, plan.sourceId) };
}

function writeFolder(plan: SourcePlan, main: string) {
  mkdirSync(plan.folder, { recursive: true });
  const manifest = sourceManifest({
    id: plan.pluginId,
    name: plan.name,
    sourceId: plan.sourceId,
    host: plan.apiHost,
    description: `${plan.name}, a paper source the engineer built: ${plan.idea.text}`,
  });
  writeFileSync(join(plan.folder, "rh-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(plan.folder, "main.mjs"), main);
}

/** Install the plugin and run a real search; it stays installed, disabled, only when the papers meet the contract. */
async function installAndTest(deps: SourceBuilderDeps, plan: SourcePlan, query: string, note: (text: string) => void) {
  const manage = deps.host.manage;
  const actor = `proposal:engineer-${plan.idea.id}` as const;
  await manage.uninstall(plan.pluginId, actor).catch(() => undefined);
  await manage.install(plan.folder, actor);
  note(`Installed ${plan.pluginId} in its sandbox; searching for “${query}”.`);
  const exports = await deps.host.exportsOf<SourceExports>(plan.pluginId);
  const client = exports.sources?.[plan.sourceId];
  if (!client) throw new Error(`activate() returned no sources.${plan.sourceId}`);
  const papers = await Promise.race([
    client.search({ query, limit: 5 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the search took more than 60 s")), SEARCH_TIMEOUT_MS).unref(),
    ),
  ]);
  const problems = contractProblems(papers, plan.sourceId, 5);
  if (problems.length) throw new Error(problems.join("; "));
  await manage.setEnabled(plan.pluginId, false, actor);
  return papers;
}

export function sourcePluginBuilder(deps: SourceBuilderDeps): Builder {
  return async ({ idea, say: note, dir }) => {
    const api = idea.assessment?.api ?? {};
    let apiHost: string;
    try {
      apiHost = new URL(api.baseUrl ?? "").hostname;
    } catch {
      throw new EngineerInvalid("the assessment names no API base URL");
    }
    const name = api.name || apiHost;
    const plan: SourcePlan = {
      idea,
      name,
      apiHost,
      sourceId: slug(name, 20),
      pluginId: `eng.${slug(name)}`,
      folder: join(dir, "plugin"),
    };
    const query = deps.testQuery();
    let feedback = "";
    for (let attempt = 1; attempt <= deps.maxAttempts(); attempt++) {
      note(`Writing the plugin (attempt ${attempt}).`);
      const { main, problems } = await write(deps, plan, feedback);
      if (!main || problems.length) {
        feedback = problems.join("; ");
        note(`Rejected before running: ${feedback}`);
        continue;
      }
      writeFolder(plan, main);
      try {
        const papers = await installAndTest(deps, plan, query, note);
        note(
          `Test passed: ${papers.length} papers, e.g. “${papers[0].title.slice(0, 120)}”. Installed disabled; enable it to use it.`,
        );
        return {
          pluginId: plan.pluginId,
          numbers: { testQuery: query, papers: papers.length, attempts: attempt, example: papers[0].title },
        };
      } catch (error) {
        feedback = error instanceof Error ? error.message : String(error);
        note(`Test failed: ${feedback}`);
        await deps.host.manage.uninstall(plan.pluginId, `proposal:engineer-${idea.id}`).catch(() => undefined);
      }
    }
    throw new EngineerInvalid(`the plugin did not pass its test in ${deps.maxAttempts()} attempts: ${feedback}`);
  };
}
