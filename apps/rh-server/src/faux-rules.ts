// Scripted replies for offline mode and tests. The charter writer gets a deterministic charter built from the brief:
// on the first draft it asks two scoping questions, then saves; a revision moves answers mentioning "out of scope"
// into outOfScope. The desk searches, judges and calls tools when told to. Everything else falls through to the
// faux model's echo.
import { call, say, type FauxRule } from "@rh/durable-agent";

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

/** A valid charter derived from the brief text. */
export function fauxCharter(brief: string) {
  const lines = brief
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
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
    queries: [
      `${topic} survey`,
      `${pick(0)} ${pick(1)}`,
      `${pick(2)} methods`,
      `${pick(3)} benchmark`,
      `${pick(4)} review`,
    ],
    outOfScope: [] as string[],
  };
}

const section = (text: string, heading: string) => text.split(`## ${heading}`)[1]?.split(/\n## /)[0]?.trim() ?? "";

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

/** The offline desk searches when asked for papers ("find papers on X", "search for X") and reports the result. */
export const deskSearchRule: FauxRule = (turn) => {
  if (turn.sections["charter-writer"] || turn.sections["card-writer"] || turn.sections["librarian"]) return undefined;
  const result = turn.results.find((r) => r.name === "search_papers");
  if (result) return say(result.text);
  const m = turn.lastUser.match(
    /\b(?:find|search(?: for)?|look for)\b(?:\s+(?:recent|new))?(?:\s+papers?)?(?:\s+(?:on|about|for))?\s+(.+)/i,
  );
  if (!m) return undefined;
  return call("search_papers", { query: m[1].replace(/[?.!]+$/, "").slice(0, 200), limit: 5 });
};

/**
 * The offline card writer: lists the candidates, presents each with the first sentence of its abstract (grounded by
 * construction), then completes the sweep. Candidates without an abstract are skipped with a reason.
 */
export const cardWriterRule: FauxRule = (turn) => {
  if (!turn.sections["card-writer"]) return undefined;
  if (turn.results.some((r) => r.name === "complete_sweep" && !r.isError)) return say("Cards written.");
  const listed = turn.results.find((r) => r.name === "list_candidates");
  if (!listed) return call("list_candidates", {});
  const blocks = listed.text
    .split("\n\n")
    .map((b) => ({
      id: Number(b.match(/^#(\d+)/)?.[1]),
      abstract: b.match(/abstract: (.*)$/m)?.[1] ?? "",
    }))
    .filter((b) => b.id);
  const presented = new Set(
    turn.calls.filter((c) => c.name === "present_paper").map((c) => Number(c.arguments.paper_id)),
  );
  const skipped = blocks.filter((b) => b.abstract === "(no abstract)" || !b.abstract);
  const next = blocks.find((b) => !presented.has(b.id) && !skipped.includes(b));
  if (next) {
    const first = next.abstract
      .split(/(?<=[.!?])\s+/)[0]
      .split(/\s+/)
      .slice(0, 60)
      .join(" ");
    return call("present_paper", { paper_id: next.id, summary: first });
  }
  return call("complete_sweep", {
    skipped: skipped.map((b) => ({ paper_id: b.id, reason: "no abstract to summarize" })),
  });
};

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  last: -1,
};

/** The offline desk records judgments said in chat: "star the second card, great foundation". */
export const deskJudgeRule: FauxRule = (turn) => {
  if (turn.sections["charter-writer"] || turn.sections["card-writer"] || turn.sections["librarian"]) return undefined;
  const result = turn.results.find((r) => r.name === "judge_card");
  if (result) return say(result.text);
  const m = turn.lastUser.match(
    /\b(star|upvote|like|downvote|dislike)\s+(?:the\s+)?(?:card\s+)?(first|second|third|fourth|fifth|sixth|seventh|\d+)(?:st|nd|rd|th)?\s*(?:card)?[,.:;-]?\s*(.*)$/i,
  );
  if (!m) return undefined;
  const verdict = /star/i.test(m[1]) ? "star" : /down|dislike/i.test(m[1]) ? "down" : "up";
  const position = ORDINALS[m[2].toLowerCase()] ?? Number(m[2]);
  return call("judge_card", { verdict, position, ...(m[3].trim() ? { reason: m[3].trim() } : {}) });
};

/**
 * The offline librarian: sections from the abstract (first sentence as summary, a "we propose/use" sentence as
 * method, a sentence with a number or "improves" as results, the rest "Not stated in the abstract"), then links the
 * first charter concept and the matched question.
 */
export const librarianRule: FauxRule = (turn) => {
  if (!turn.sections["librarian"]) return undefined;
  const prompt = turn.lastUser;
  if (turn.results.some((r) => r.name === "link_note" && !r.isError)) return say("Done.");
  if (!turn.results.some((r) => r.name === "write_evidence_note" && !r.isError)) {
    const abstract = prompt.split("ABSTRACT:\n")[1]?.split("\n\nRESEARCH_QUESTIONS:")[0]?.trim() ?? "";
    const sentences = abstract === "(no abstract)" ? [] : abstract.split(/(?<=[.!?])\s+/).filter(Boolean);
    const find = (re: RegExp) => sentences.find((x) => re.test(x));
    const none = "Not stated in the abstract";
    return call("write_evidence_note", {
      summary: sentences[0] ?? none,
      contributions: find(/\b(we (propose|introduce|present)|novel|first)\b/i) ?? none,
      method: find(/\b(we (propose|use|train|fine-tune|develop|apply)|our (model|method|approach))\b/i) ?? none,
      results: find(/\b(improv|outperform|achiev|\d)/i) ?? none,
      limitations: none,
      open_questions: none,
    });
  }
  const concept = prompt.match(/^CHARTER_CONCEPTS: ([^;\n]+)/m)?.[1]?.trim();
  const question = prompt.match(/^MATCHED_QUESTION: (Q\d+)/m)?.[1];
  return call("link_note", { concepts: concept ? [concept] : ["research"], questions: question ? [question] : [] });
};

/** The offline desk calls a named tool when told to: "use sample_echo {"text": "hi"}" (plugin tools, offline). */
export const deskToolRule: FauxRule = (turn) => {
  if (turn.sections["charter-writer"] || turn.sections["card-writer"] || turn.sections["librarian"]) return undefined;
  const m = turn.lastUser.match(/^use\s+([a-z][a-z0-9_]*)\s*(\{.*\})?\s*$/is);
  if (!m) return undefined;
  const result = turn.results.find((r) => r.name === m[1]);
  if (result) return say(result.text);
  let args: Record<string, unknown> = {};
  try {
    args = m[2] ? JSON.parse(m[2]) : {};
  } catch {
    return say(`The arguments for ${m[1]} are not valid JSON.`);
  }
  return call(m[1], args);
};

/** Default scripted rules for offline mode. */
export const offlineRules: FauxRule[] = [
  charterWriterRule,
  cardWriterRule,
  librarianRule,
  deskJudgeRule,
  deskSearchRule,
  deskToolRule,
];
