// A valid sample charter for tests (questions get Q-ids and weights during validation).
import type { Charter } from "../../src/charter.ts";

export const sampleCharter = (over: Partial<Record<keyof Charter, unknown>> = {}) => ({
  questions: [{ text: "How do protein LMs transfer to structure?" }, { text: "Which tasks need fine-tuning?", weight: 1.5 }, { text: "What do embeddings miss?" }],
  concepts: ["protein language models", "contact maps"],
  subAreas: ["structure prediction"],
  queries: ["protein language model", "ESM embeddings", "contact prediction", "protein fine-tuning", { text: "PLM benchmark", weight: 0.5 }],
  outOfScope: [],
  ...over,
});
