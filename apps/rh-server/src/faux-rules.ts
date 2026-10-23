// Scripted replies for offline mode and tests. The charter writer gets a deterministic charter built from the brief:
// on the first draft it asks two scoping questions, then saves; a revision moves answers mentioning "out of scope"
// into outOfScope. Everything else falls through to the faux model's echo.
import { call, say, type FauxRule } from "@rh/durable-agent";

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

/** A valid charter derived from the brief text. */
export function fauxCharter(brief: string) {
  const lines = brief.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).filter(Boolean);
  const topic = lines[0]?.slice(0, 80) || "the project theme";
  const vocab = [...new Set(words(brief))];
  const pick = (i: number) => vocab[i % Math.max(vocab.length, 1)] ?? `topic${i}`;
  return {
    questions: [
      { text: `What are the foundations of ${topic}?` },
      { text: `Which methods work best for ${pick(1)}?`, weight: 1.5 },
      { text: `What remains open in ${pick(2)}?` },
    ],
    concepts: [topic.toLowerCase(), pick(0), pick(3)].filter((v, i, a) => a.indexOf(v) === i),
    subAreas: [pick(4)],
    queries: [`${topic} survey`, `${pick(0)} ${pick(1)}`, `${pick(2)} methods`, `${pick(3)} benchmark`, `${pick(4)} review`],
    outOfScope: [] as string[],
  };
}

const section = (text: string, heading: string) =>
  text.split(`## ${heading}`)[1]?.split(/\n## /)[0]?.trim() ?? "";

export const charterWriterRule: FauxRule = (turn) => {
  if (!turn.sections["charter-writer"]) return undefined;
  if (turn.results.some((r) => r.name === "save_charter_draft" && !r.isError)) return say("Draft saved.");
  const prompt = turn.lastUser;
  if (prompt.includes("Draft the charter")) {
    const left = Number(prompt.match(/QUESTIONS_LEFT: (\d+)/)?.[1] ?? 0);
    const asked = turn.calls.some((c) => c.name === "ask_scoping_questions");
    if (!asked && left >= 2)
      return call("ask_scoping_questions", {
        questions: ["Are clinical applications in scope?", "Do you prefer applied or theoretical work?"],
      });
    return call("save_charter_draft", fauxCharter(section(prompt, "Brief")));
  }
  if (prompt.includes("Revise the charter draft")) {
    let draft: any = {};
    try {
      draft = JSON.parse(section(prompt, "Current draft"));
    } catch {}
    const answers = [...section(prompt, "Answers").matchAll(/A: (.+)/g)].map((m) => m[1].trim());
    const outOfScope = [...(draft.outOfScope ?? [])];
    const concepts = [...(draft.concepts ?? [])];
    for (const a of answers) {
      const m = a.match(/^(.*?)\s+(?:are|is)\s+out of scope/i);
      if (m) outOfScope.push(m[1].replace(/^no,?\s*/i, "").trim());
      else if (concepts.length < 30) concepts.push(a.slice(0, 120));
    }
    return call("save_charter_draft", {
      questions: draft.questions,
      concepts,
      subAreas: draft.subAreas,
      queries: draft.queries,
      outOfScope,
    });
  }
  return undefined;
};

/** Default scripted rules for offline mode. */
export const offlineRules: FauxRule[] = [charterWriterRule];
