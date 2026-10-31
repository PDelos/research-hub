// Choosing a run's focus (spec weekly-upgrade; design v1-4 D2): Jev weighs each slot's last measurement, the user's
// digest comments since the last run, the failure analysis and the recent foci; when Jev is unsure or unavailable,
// the next focus in the rotation (skipping the converter while there is no alternative to it).
import type { BuiltinHost } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import type { FullTextExports } from "../rh.fulltext/main.ts";
import type { HarnessExports } from "../rh.harness/main.ts";
import { analyze } from "./ranking.ts";
import type { UpgradeStore } from "./store.ts";

export const FOCUSES = ["ranking", "embedder", "converter", "scout-addons"] as const;
export type Focus = (typeof FOCUSES)[number];
export const FOCUS_MIN_CONFIDENCE = 0.4;

export interface FocusDeps {
  context: PluginContext;
  host: BuiltinHost;
  harness: HarnessExports;
  store: UpgradeStore;
}

/** Converters other than the active one that can run here (Docling only in the full image). */
export async function converterAlternatives(host: BuiltinHost) {
  try {
    const fulltext = await host.exportsOf<FullTextExports>("rh.fulltext");
    return (await fulltext.converters()).filter((c) => !c.active && c.available);
  } catch {
    return [];
  }
}

/** The next focus after the last one; the converter is skipped while it has no alternative. */
async function rotation({ host, store }: FocusDeps): Promise<Focus> {
  const last = store.lastDone()?.focus;
  let next = last ? FOCUSES[(FOCUSES.indexOf(last) + 1) % FOCUSES.length] : FOCUSES[0];
  if (next === "converter" && !(await converterAlternatives(host)).length)
    next = FOCUSES[(FOCUSES.indexOf(next) + 1) % FOCUSES.length];
  return next;
}

/** The user's latest digest comments (none when the digest plugin has no table yet). */
function commentsSince(host: BuiltinHost, since: string): { section: string; text: string }[] {
  try {
    return host.db
      .prepare("SELECT section, text FROM p_rh_digest__comments WHERE created_at >= ? ORDER BY id DESC LIMIT 20")
      .all(since) as { section: string; text: string }[];
  } catch {
    return [];
  }
}

const ageDays = (iso?: string) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 86_400_000) : null);

/** What Jev sees about the slots a run can work on; the converter's alternatives included. */
async function slotFacts(deps: FocusDeps): Promise<string> {
  const alternatives = (await converterAlternatives(deps.host)).map((c) => c.title);
  const slots = deps.harness
    .slots()
    .filter((s) => s.id === "ranking" || s.id === "embedder" || s.id === "converter")
    .map((s) => ({
      slot: s.id,
      active: s.active.name,
      lastResult: s.last?.result.label ?? "never measured",
      ageDays: ageDays(s.last?.createdAt),
    }));
  return JSON.stringify(
    slots.map((x) =>
      x.slot === "converter" ? { ...x, alternatives: alternatives.length ? alternatives : "none here" } : x,
    ),
  );
}

export async function chooseFocus(deps: FocusDeps): Promise<{ focus: Focus; reason: string; costUsd: number }> {
  const { context, host, store } = deps;
  const comments = commentsSince(host, store.lastDone()?.started_at ?? "1970-01-01");
  const recent = store.recentFoci(3);
  const slots = await slotFacts(deps);
  const failures = JSON.stringify(analyze(host.db));
  const fallback = await rotation(deps);
  try {
    const { answers, costUsd } = await context.rh.decisions.decide("upgrade-focus", {
      slots,
      comments: comments.length ? JSON.stringify(comments) : "none",
      failures,
      recent: recent.length ? recent.join(", ") : "none",
    });
    const answer = answers.focus as { choice?: string; confidence?: number; reason?: string } | undefined;
    const choice = answer?.choice as Focus | undefined;
    const confidence = answer?.confidence ?? 0;
    if (choice && FOCUSES.includes(choice) && confidence >= FOCUS_MIN_CONFIDENCE) {
      const quoted = comments.length ? ` Your comment: “${comments[0].text.slice(0, 200)}”.` : "";
      return { focus: choice, reason: `Chosen by Jev (confidence ${confidence.toFixed(2)}).${quoted}`, costUsd };
    }
    return { focus: fallback, reason: "Jev was unsure, so the next focus in the rotation.", costUsd };
  } catch (error) {
    context.log.warn("upgrades.focus_failed", { error: String(error) });
    return { focus: fallback, reason: "The next focus in the rotation (Jev unavailable).", costUsd: 0 };
  }
}
