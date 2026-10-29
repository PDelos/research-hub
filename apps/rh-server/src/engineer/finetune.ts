// Fine-tuning an embedder on the user's judgments (spec engineer: Fine-tuned embedder on Kaggle; design v1-8 D5): the
// training pairs (a research question and a paper the user liked under it; disliked papers as hard negatives) and the
// Kaggle script that fine-tunes a small open model with sentence-transformers and saves it under model/.
import type { Charter } from "../charter.ts";
import type { Db } from "../db.ts";

export const BASE_MODEL = "BAAI/bge-small-en-v1.5";
export const MIN_PAIRS = 20;
export const MAX_PAIRS = 2_000;

export interface TrainingData {
  pairs: { query: string; positive: string }[];
  negatives: string[];
}

const text = (p: { title: string; abstract: string | null }) => `${p.title}. ${p.abstract ?? ""}`.slice(0, 2_000);

export function trainingData(db: Db, charter: Charter): TrainingData {
  const rows = db
    .prepare(
      `SELECT p.title, p.abstract, c.matched_question q, j.verdict FROM judgments j JOIN cards c ON c.id = j.card_id
         JOIN papers p ON p.id = j.paper_id ORDER BY j.updated_at DESC`,
    )
    .all() as { title: string; abstract: string | null; q: string | null; verdict: string }[];
  const question = new Map(charter.questions.map((q) => [q.id, q.text]));
  const pairs = rows
    .filter((r) => r.verdict !== "down" && r.q && question.has(r.q))
    .map((r) => ({ query: question.get(r.q!)!, positive: text(r) }))
    .slice(0, MAX_PAIRS);
  const negatives = rows
    .filter((r) => r.verdict === "down")
    .map(text)
    .slice(0, MAX_PAIRS);
  return { pairs, negatives };
}

/** The Kaggle script: install, fine-tune with MultipleNegativesRankingLoss (hard negatives when there are some), save. */
export function trainingScript(data: TrainingData, baseModel = BASE_MODEL, epochs = 2): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  return `# Research Hub: fine-tune ${baseModel} on one project's judgments (written by the hub's engineer).
import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "sentence-transformers>=3", "datasets"], check=True)
import base64, json, os, random
from datasets import Dataset
from sentence_transformers import SentenceTransformer, losses
from sentence_transformers.trainer import SentenceTransformerTrainer
from sentence_transformers.training_args import SentenceTransformerTrainingArguments

data = json.loads(base64.b64decode("${payload}"))
random.seed(7)
negatives = data["negatives"]
rows = {"anchor": [], "positive": []}
if negatives:
    rows["negative"] = []
for p in data["pairs"]:
    rows["anchor"].append(p["query"])
    rows["positive"].append(p["positive"])
    if negatives:
        rows["negative"].append(random.choice(negatives))
train = Dataset.from_dict(rows)
model = SentenceTransformer("${baseModel}")
args = SentenceTransformerTrainingArguments(output_dir="/kaggle/working/run", num_train_epochs=${epochs},
    per_device_train_batch_size=16, learning_rate=2e-5, warmup_ratio=0.1, logging_steps=10, save_strategy="no", report_to=[])
trainer = SentenceTransformerTrainer(model=model, args=args, train_dataset=train,
    loss=losses.MultipleNegativesRankingLoss(model))
trainer.train()
model.save("/kaggle/working/model")
print(json.dumps({"pairs": len(data["pairs"]), "negatives": len(negatives), "base": "${baseModel}"}))
`;
}
