// Build typed Jev answers and a scripted `decide` that answers each question by a function of its id and the state.
import type { Answer, Decide, Question, State, SystemOneResult } from "@rh/jev";

/** A score answer whose normalized value (score / top level) is `value`. */
export function score(value: number, levels: number): Answer {
  const top = levels - 1;
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) {
    legend[String(i)] = `level ${i}`;
    probabilities[String(i)] = i === Math.round(value * top) ? 1 : 0;
  }
  return { type: "score", score: value * top, legend, probabilities, confidence: 0.9 };
}

export const noul = (p: number): Answer => ({ type: "noul", noul: p });

export function choice(option: string, options: string[], confidence = 0.9): Answer {
  const rest = (1 - confidence) / Math.max(1, options.length - 1);
  return {
    type: "choice",
    choice: option,
    confidence,
    probabilities: Object.fromEntries(options.map((o) => [o, o === option ? confidence : rest])),
  };
}

/** `answer(question id without command prefix, command, question, state)`; return undefined for a neutral default. */
export type Script = (id: string, command: string, q: Question, state: State) => Answer | undefined;

const optionsOf = (question: Question) => Object.keys((question as { criteria: object }).criteria);

/** A choice of `option` among the question's own options. */
export const pick = (option: string) => (question: Question) => choice(option, optionsOf(question));

/** A script with one answer per question id (a function gets the question); other ids get the neutral default. */
export function byId(answers: Record<string, Answer | ((question: Question) => Answer)>): Script {
  return (id, _command, question) => {
    const answer = answers[id];
    return typeof answer === "function" ? answer(question) : answer;
  };
}

/** Uncertain: the middle score, an even yes/no, or the first option. */
function neutral(question: Question): Answer {
  if (question.type === "score") return score(0.5, question.criteria.length);
  if (question.type === "noul") return noul(0.5);
  return choice(optionsOf(question)[0], optionsOf(question));
}

export function scripted(script: Script, cost = 0.00003) {
  const calls: { questions: string[]; state: State }[] = [];
  let failing: Error | undefined;
  const decide: Decide = async (state, questions) => {
    if (failing) throw failing;
    calls.push({ questions: Object.keys(questions), state });
    const answers: Record<string, Answer> = {};
    for (const [fullId, q] of Object.entries(questions)) {
      const [command, id] = fullId.includes("__") ? fullId.split("__") : ["", fullId];
      answers[fullId] = script(id, command, q, state) ?? neutral(q);
    }
    return {
      model: "jev-scripted",
      answers,
      usage: { input_tokens: 200, output_tokens: 0 },
      raw: {} as SystemOneResult["raw"],
      meta: {
        provider: "mock",
        requestedModel: "jev",
        resolvedModel: "jev-scripted",
        elapsedMs: 1,
        attempts: 1,
        cost: { amount: cost, source: "reported" },
      },
    } as SystemOneResult;
  };
  return { decide, calls, fail: (error?: Error) => (failing = error) };
}
