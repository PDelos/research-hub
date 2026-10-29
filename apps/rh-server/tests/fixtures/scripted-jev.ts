// A scripted Jev `decide` for facet tests: labels each sentence by a rule and counts calls.
import type { Decide, SystemOneResult } from "@rh/jev";

export type Rule = (sentence: string) => [facet: string, confidence: number];

/** Keyword rule: "we propose/use/train..." → method, numbers/"improves" → result, else background. */
export const keywordRule: Rule = (state) => {
  if (/\b(code|available|funded)\b/i.test(state)) return ["other", 0.9];
  if (/\b(we (propose|use|train|fine-tune|introduce|apply|develop|build)|our (model|method|approach))\b/i.test(state))
    return ["method", 0.9];
  if (/\b(improv|outperform|achiev|show|reach|result|accuracy|\d+(\.\d+)?%)/i.test(state)) return ["result", 0.85];
  return ["background", 0.8];
};

export function scriptedJev(rule: Rule = keywordRule) {
  const calls: { sentences: string[] }[] = [];
  const decide: Decide = async (_state, questions) => {
    const answers: SystemOneResult["answers"] = {};
    const sentences: string[] = [];
    for (const [id, q] of Object.entries(questions)) {
      const sentence = String((q.instructions as Record<string, unknown>).sentence);
      sentences.push(sentence);
      const [choice, confidence] = rule(sentence);
      const options = Object.keys((q as { criteria: Record<string, unknown> }).criteria);
      const rest = (1 - confidence) / (options.length - 1);
      answers[id] = {
        type: "choice",
        choice,
        confidence,
        probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? confidence : rest])),
      };
    }
    calls.push({ sentences });
    return {
      model: "jev-scripted",
      answers,
      usage: { input_tokens: 100, output_tokens: 10 },
      raw: {} as SystemOneResult["raw"],
      meta: {
        provider: "mock",
        requestedModel: "jev",
        resolvedModel: "jev-scripted",
        elapsedMs: 1,
        attempts: 1,
        cost: { amount: 0.000014, source: "reported" },
      },
    } as SystemOneResult;
  };
  return { decide, calls };
}
