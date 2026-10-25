// The research desk's feedback tools (spec paper-feedback: Judge a card, via chat; design D3): `recent_cards` lists
// the latest sweep's cards with positions, and `judge_card` records a verdict on one of them by position or id.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { defineAppTool, once, toolError, toolText } from "@rh/durable-agent";
import type { Feedback } from "./feedback.ts";
import { JudgmentInvalid, REASON_MAX, VERDICTS } from "./feedback.ts";
import type { CardStore } from "../sweep/cards.ts";
import type { PaperStore } from "../papers/store.ts";

const ICON = { up: "👍", down: "👎", star: "⭐" } as const;

export function feedbackTools(deps: () => { cards: CardStore; feedback: Feedback; store: PaperStore }): Extension {
  const latest = () => {
    const { cards } = deps();
    const all = cards.list(200);
    const sweepId = all[0]?.sweepId;
    return all.filter((c) => c.sweepId === sweepId);
  };
  const recent = defineAppTool({
    name: "recent_cards",
    description:
      "List the paper cards of the latest sweep with their position (1 = first), card id and current verdict.",
    returns: "Text: one line per card.",
    parameters: Type.Object({}),
    execute: async () => {
      const { feedback, store } = deps();
      const cards = latest();
      if (!cards.length) return toolText("There are no cards yet.");
      return toolText(
        cards
          .map((c, i) => {
            const j = feedback.get(c.id);
            return `${i + 1}. card ${c.id}: ${store.get(c.paperId)?.title ?? "?"}${j ? ` · ${ICON[j.verdict]}${j.reason ? ` "${j.reason}"` : ""}` : ""}`;
          })
          .join("\n"),
      );
    },
  });
  const judge = defineAppTool({
    name: "judge_card",
    description: `Record the user's verdict on a card: ${VERDICTS.join(", ")} (👎 not useful, 👍 interesting, ⭐ add to the knowledge base), with their reason. Give the position in the latest sweep (1 = first) or the card id.`,
    returns: "Text: what was recorded.",
    parameters: Type.Object({
      verdict: Type.String({ description: "up, down or star" }),
      position: Type.Optional(Type.Number({ description: "Position in the latest sweep, 1 = first card" })),
      card_id: Type.Optional(Type.Number({ description: "The card id (from recent_cards)" })),
      reason: Type.Optional(
        Type.String({ description: `The user's reason in their words, at most ${REASON_MAX} characters` }),
      ),
    }),
    execute: async (args, api, ctx) => {
      const { feedback, cards, store } = deps();
      let cardId = args.card_id;
      if (cardId === undefined && args.position !== undefined) cardId = latest()[args.position - 1]?.id;
      if (cardId === undefined || !cards.get(cardId))
        return toolError("No such card.", ["Call recent_cards and use a listed position or card id."]);
      const result = await once<string>(api, "judge", ctx, async () => {
        try {
          const j = feedback.judge(cardId!, args.verdict, args.reason);
          return `ok:${ICON[j.verdict]} recorded on card ${cardId} (${store.get(j.paperId)?.title ?? "?"})${j.reason ? ` with the reason "${j.reason}"` : ""}.`;
        } catch (error) {
          if (error instanceof JudgmentInvalid) return `error:${error.message}`;
          throw error;
        }
      });
      if (result.startsWith("error:"))
        return toolError(`Not recorded: ${result.slice(6)}.`, ["Fix it and call judge_card again."]);
      return toolText(result.slice(3));
    },
  });
  return defineExtension({ name: "feedback-tools", tools: [recent, judge] });
}
