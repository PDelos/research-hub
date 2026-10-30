// Embeddings: one configured OpenRouter model for every paper (spec paper-representations), batched up to 32 inputs
// per call, each call recorded with tokens and cost in embedding_calls. Offline mode uses a deterministic fake whose
// vectors overlap when texts share words, so tests can assert similarity ordering without the network.
import { createHash } from "node:crypto";
import { currentCostTag } from "../cost-tag.ts";
import { nowIso, type Db } from "../db.ts";
import { PoliteHttp } from "../papers/http.ts";

export const EMBED_BATCH = 32;
export const OPENROUTER_EMBEDDINGS = "https://openrouter.ai/api/v1/embeddings";

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** One L2-normalized vector per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingCall {
  model: string;
  inputs: number;
  tokens?: number;
  costUsd?: number;
  costSource: "reported" | "unknown" | "offline";
  elapsedMs: number;
  error?: string;
}

/** Records every embedding call for the cost totals. */
interface EmbeddingsBody {
  data?: { embedding: number[]; index: number }[];
  usage?: { total_tokens?: number; prompt_tokens?: number; cost?: number };
  error?: { message?: string };
}

export class EmbeddingLedger {
  constructor(private readonly db: Db) {}

  record(call: EmbeddingCall): void {
    this.db
      .prepare(
        "INSERT INTO embedding_calls (model, inputs, tokens, cost_usd, cost_source, elapsed_ms, error, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        call.model,
        call.inputs,
        call.tokens ?? null,
        call.costUsd ?? null,
        call.costSource,
        call.elapsedMs,
        call.error ?? null,
        currentCostTag() ?? null,
        nowIso(),
      );
  }

  totals(sinceIso?: string): { calls: number; inputs: number; tokens: number; usd: number } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) calls, COALESCE(SUM(inputs), 0) inputs, COALESCE(SUM(tokens), 0) tokens, COALESCE(SUM(cost_usd), 0) usd FROM embedding_calls WHERE error IS NULL AND created_at >= ?",
      )
      .get(sinceIso ?? "") as { calls: number; inputs: number; tokens: number; usd: number };
    return { calls: Number(row.calls), inputs: Number(row.inputs), tokens: Number(row.tokens), usd: Number(row.usd) };
  }
}

export function l2normalize(left: Float32Array): Float32Array {
  let sum = 0;
  for (const x of left) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < left.length; i++) left[i] /= norm;
  return left;
}

export class OpenRouterEmbedder implements Embedder {
  private readonly http: PoliteHttp;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      dims: number;
      ledger: EmbeddingLedger;
      http?: PoliteHttp;
      url?: string;
    },
  ) {
    this.http = options.http ?? new PoliteHttp();
  }

  get model(): string {
    return this.options.model;
  }

  get dims(): number {
    return this.options.dims;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH)
      out.push(...(await this.batch(texts.slice(i, i + EMBED_BATCH))));
    return out;
  }

  /** One unit vector per input, in input order; a short answer or a wrong size is an error. */
  private vectorsOf(body: EmbeddingsBody, count: number): Float32Array[] {
    if (!body.data || body.data.length !== count)
      throw new Error(body.error?.message ?? `expected ${count} embeddings, got ${body.data?.length ?? 0}`);
    return [...body.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => {
        if (this.dims && item.embedding.length !== this.dims)
          throw new Error(`${this.model} returned ${item.embedding.length} dimensions, RH_EMBED_DIMS is ${this.dims}`);
        return l2normalize(Float32Array.from(item.embedding));
      });
  }

  private async batch(input: string[]): Promise<Float32Array[]> {
    const started = Date.now();
    const call: EmbeddingCall = { model: this.model, inputs: input.length, costSource: "unknown", elapsedMs: 0 };
    try {
      const body = await this.http.json<EmbeddingsBody>(this.options.url ?? OPENROUTER_EMBEDDINGS, {
        source: "embeddings",
        method: "POST",
        // A batch of 32 abstracts can take a while; allow 60 s per attempt and 3 minutes in all.
        timeoutMs: 60_000,
        budgetMs: 180_000,
        // dims 0: the model's native size (benchmarks of models that do not take `dimensions`).
        body: JSON.stringify({
          model: this.model,
          input,
          ...(this.dims ? { dimensions: this.dims } : {}),
          encoding_format: "float",
        }),
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      });
      const vectors = this.vectorsOf(body, input.length);
      call.tokens = body.usage?.total_tokens ?? body.usage?.prompt_tokens;
      if (typeof body.usage?.cost === "number") {
        call.costUsd = body.usage.cost;
        call.costSource = "reported";
      }
      return vectors;
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      call.elapsedMs = Date.now() - started;
      this.options.ledger.record(call);
    }
  }
}

/**
 * Offline embedder: each word (lowercased, simple plural folding) maps to a hash-seeded random direction; a text's
 * vector is the normalized sum of its words' directions, so texts sharing words are close.
 */
export class FakeEmbedder implements Embedder {
  readonly model = "offline/fake-embedding";
  constructor(
    readonly dims: number,
    private readonly ledger?: EmbeddingLedger,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    for (let i = 0; i < texts.length; i += EMBED_BATCH)
      this.ledger?.record({
        model: this.model,
        inputs: Math.min(EMBED_BATCH, texts.length - i),
        costUsd: 0,
        costSource: "offline",
        elapsedMs: 0,
      });
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): Float32Array {
    const left = new Float32Array(this.dims);
    for (const word of fakeWords(text)) {
      const seed = createHash("sha256").update(word).digest();
      let state = seed.readUInt32LE(0) || 1;
      for (let i = 0; i < this.dims; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        left[i] += ((state >>> 0) / 0xffffffff) * 2 - 1;
      }
    }
    return l2normalize(left);
  }
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "to",
  "with",
  "we",
  "our",
  "is",
  "are",
  "by",
  "from",
  "this",
  "that",
  "as",
  "at",
  "be",
]);

function fakeWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !STOP.has(w))
    .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));
}
