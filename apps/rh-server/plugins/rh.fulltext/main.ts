// Built-in plugin rh.fulltext (spec full-text; design v1-6 D1–D5): the full text of starred papers (and others on
// request) from the first source that has it: arXiv HTML, Europe PMC JATS, bioRxiv/medRxiv JATS, then the PDF through
// the active converter (the Converter slot). The librarian writes notes from it and facet vectors use its sections.
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { facetTexts, withinBudget, type Section } from "../../src/fulltext/parse.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { KbExports } from "../rh.kb/main.ts";
import { Converters, FullTextInvalid } from "./converters.ts";
import { attemptsFor, firstWithSections, type SourceDeps } from "./sources.ts";
import { FullTextStore } from "./store.ts";

export { MAX_PDF_BYTES, openAccessHost } from "./sources.ts";
export { FullTextInvalid } from "./converters.ts";

export const INGEST_WAIT_MS = 90_000;

export interface FullText {
  paperId: number;
  status: "ok" | "missing";
  /** arxiv-html, europepmc-jats, biorxiv-jats or pdf:<converter id>. */
  source: string | null;
  sections: Section[];
  chars: number;
  /** Why each source before the one used (or all of them) gave nothing. */
  notes: string[];
  fetchedAt: string;
}

/** What a converter plugin exports (the Converter slot). */
export interface ConverterExports {
  convert(pdf: Uint8Array): Promise<Section[]>;
  /** Whether it can run here (Docling needs its add-on image). */
  available(): { ok: boolean; reason?: string };
}

export interface ConverterView {
  id: string;
  title: string;
  pluginId: string;
  active: boolean;
  available: boolean;
  reason?: string;
}

export interface FullTextExports {
  get(paperId: number): FullText | undefined;
  /** The stored full text, else fetch it now (one fetch per paper at a time). */
  ensure(paperId: number): Promise<FullText>;
  /** Fetch again, replacing what is stored. */
  refetch(paperId: number): Promise<FullText>;
  converters(): Promise<ConverterView[]>;
  /** Convert a PDF with a converter (the active one by default), e.g. for the slot's preset. */
  convert(pdf: Uint8Array, converterId?: string): Promise<Section[]>;
}

export function activate(context: PluginContext): FullTextExports {
  const host = hostOf(context);
  const { rh } = context;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const kb = context.exports["rh.kb"] as KbExports;
  const texts = new FullTextStore(rh, host.db, context.log);
  const get = (paperId: number) => texts.get(paperId);
  const { contributions } = host.services;
  const converters = new Converters(host, () => context.settings);
  const convert: FullTextExports["convert"] = (pdf, converterId) => converters.convert(pdf, converterId);
  const hosts = context.manifest.permissions.network ?? [];
  const sources: SourceDeps = {
    http: rh.http,
    hosts,
    convert,
    activeConverter: () => contributions.activeContribution("fulltext.converter", context.settings)?.id,
  };

  /** Tell listeners, and refresh the facet vectors (background, method, result) from the sections. */
  const announce = async (paperId: number) => {
    rh.events.emit("fulltext.ready", { paperId });
    try {
      await papers.vectors.refresh(paperId);
    } catch (error) {
      context.log.warn("fulltext.vectors_failed", { paperId, error: String(error) });
    }
  };

  /** Each source in order; the first with sections wins. */
  const fetchFullText = async (paperId: number): Promise<FullText> => {
    const paper = papers.store.get(paperId);
    if (!paper) throw new FullTextInvalid(`no paper ${paperId}`);
    const notes: string[] = [];
    const attempts = attemptsFor(sources, paper);
    if (!attempts.length) notes.push("no arXiv id, PMCID, bioRxiv DOI or open-access link");
    const found = await firstWithSections(attempts, notes);
    texts.save(paperId, found, notes);
    if (found) await announce(paperId);
    return get(paperId)!;
  };

  const inFlight = new Map<number, Promise<FullText>>();
  const once = (paperId: number, force: boolean): Promise<FullText> => {
    const stored = force ? undefined : get(paperId);
    if (stored) return Promise.resolve(stored);
    let pending = inFlight.get(paperId);
    if (!pending) {
      pending = fetchFullText(paperId).finally(() => inFlight.delete(paperId));
      inFlight.set(paperId, pending);
    }
    return pending;
  };

  // Facet vectors use the stored sections; notes get the text within a budget, waiting at most 90 s.
  papers.vectors.setFullTextFacets((paperId) => {
    const stored = get(paperId);
    return stored?.status === "ok" ? facetTexts(stored.sections) : undefined;
  });
  kb.ingest.setFullText(async (paperId) => {
    const fullText = await Promise.race([
      once(paperId, false),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), INGEST_WAIT_MS).unref()),
    ]);
    return fullText?.status === "ok" ? withinBudget(fullText.sections) : undefined;
  });
  context.subscriptions.push({
    dispose: async () => {
      papers.vectors.setFullTextFacets(undefined);
      kb.ingest.setFullText(undefined);
      await Promise.allSettled(inFlight.values());
    },
  });

  return {
    get,
    ensure: (paperId) => once(paperId, false),
    refetch: (paperId) => once(paperId, true),
    converters: () => converters.views(),
    convert,
  };
}
