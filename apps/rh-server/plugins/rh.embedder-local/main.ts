// Built-in plugin rh.embedder-local (spec slots: Local embedder alternative; design v1-8 D6): an Embedder slot
// alternative that embeds with a model stored in the project (e.g. fine-tuned by the engineer on Kaggle), through a
// small sentence-transformers server: started here with RH_LOCAL_EMBED=on (research-hub:full), or at RH_LOCAL_EMBED_URL.
import { isAbsolute, join, normalize } from "node:path";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { LocalServer } from "../../src/kernel/local-server.ts";
import type { Embedder, EmbeddingLedger } from "../../src/representations/embed.ts";
import type { EmbedderExports } from "../rh.papers/main.ts";

export const START_TIMEOUT_MS = 180_000;

export interface LocalEmbedderExports extends EmbedderExports {
  available(): { ok: boolean; reason?: string };
  /** The vector size of a model (one probe embedding). */
  probeDims(model: string): Promise<number>;
}

const BATCH = 64;

/** A model folder inside the project's data folder (never elsewhere). */
function modelPath(dataDir: string, model: string): string {
  const rel = normalize(model).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!model || isAbsolute(model) || rel.startsWith(".."))
    throw new Error(`model must be a folder inside the data folder, got "${model}"`);
  return join(dataDir, rel);
}

/** One request to the local embedding server. */
async function embedBatch(base: string, model: string, texts: string[]): Promise<Float32Array[]> {
  const response = await fetch(`${base}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, texts }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = (await response.json()) as { vectors?: number[][]; error?: string };
  if (!response.ok || !body.vectors) throw new Error(`local embedder: ${body.error ?? `HTTP ${response.status}`}`);
  return body.vectors.map((v) => new Float32Array(v));
}

export function activate(context: PluginContext): LocalEmbedderExports {
  const host = hostOf(context);
  const external = process.env.RH_LOCAL_EMBED_URL?.trim().replace(/\/$/, "");
  const local = (process.env.RH_LOCAL_EMBED?.trim().toLowerCase() ?? "off") === "on";
  const port = Number(process.env.RH_LOCAL_EMBED_PORT ?? 5002);
  const base = external || `http://127.0.0.1:${port}`;
  const server = new LocalServer({
    base,
    command: process.env.RH_LOCAL_EMBED_PYTHON?.trim() || "/opt/docling/bin/python",
    args: [join(context.dir, "embed-server.py"), "--port", String(port)],
    name: "the embedding server",
    event: "local_embed",
    startTimeoutMs: START_TIMEOUT_MS,
    log: host.log,
  });
  // An external embedding server is not ours to start.
  const start = () => (external ? Promise.resolve() : server.start());
  context.subscriptions.push({ dispose: () => server.stop() });

  const embedWith = async (model: string, texts: string[], ledger?: EmbeddingLedger): Promise<Float32Array[]> => {
    await start();
    const started = Date.now();
    const out: Float32Array[] = [];
    const path = modelPath(host.dir, model);
    for (let i = 0; i < texts.length; i += BATCH)
      out.push(...(await embedBatch(base, path, texts.slice(i, i + BATCH))));
    ledger?.record({
      model: `local/${model}`,
      inputs: texts.length,
      costUsd: 0,
      costSource: "offline",
      elapsedMs: Date.now() - started,
    });
    return out;
  };
  const config = () => ({
    model: `local/${(context.settings.model as string | undefined) ?? ""}`,
    dims: (context.settings.dims as number | undefined) ?? 0,
  });
  context.onSettingsChange(() => context.rh.events.emit("embedder.changed", config()));

  return {
    available: () =>
      external || local
        ? { ok: true }
        : { ok: false, reason: "needs the research-hub:full image (RH_LOCAL_EMBED=on) or RH_LOCAL_EMBED_URL" },
    config,
    async probeDims(model) {
      return (await embedWith(model, ["size probe"]))[0].length;
    },
    createEmbedder({ ledger, model, dims }): Embedder {
      const name = model?.replace(/^local\//, "") ?? (context.settings.model as string | undefined) ?? "";
      return {
        model: `local/${name}`,
        dims: dims ?? config().dims,
        embed: (texts) => embedWith(name, texts, ledger),
      };
    },
  };
}
