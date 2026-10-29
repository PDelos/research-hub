// Built-in plugin rh.fulltext (spec full-text; design v1-6 D1–D5): the full text of starred papers (and others on
// request) from the first source that has it: arXiv HTML, Europe PMC JATS, bioRxiv/medRxiv JATS, then the PDF through
// the active converter (the Converter slot). The librarian writes notes from it and facet vectors use its sections.
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { hostAllowed } from "../../src/kernel/permissions.ts";
import {
  arxivHtmlToSections,
  facetTexts,
  jatsToSections,
  withinBudget,
  type Section,
} from "../../src/fulltext/parse.ts";
import type { PapersExports } from "../rh.papers/main.ts";
import type { KbExports } from "../rh.kb/main.ts";

export const MAX_PDF_BYTES = 40_000_000;
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

export class FullTextInvalid extends Error {}

/** Hosts whose open-access links are fetched (the manifest lists the same ones). */
export function openAccessHost(url: string, hosts: readonly string[]): boolean {
  try {
    return hostAllowed(hosts, new URL(url).hostname);
  } catch {
    return false;
  }
}

export function activate(context: PluginContext): FullTextExports {
  const host = hostOf(context);
  const { db } = host;
  const { rh } = context;
  const { papers } = context.exports["rh.papers"] as PapersExports;
  const kb = context.exports["rh.kb"] as KbExports;
  const table = rh.db.table("texts");
  rh.db.migrate([
    {
      version: 1,
      sql: `CREATE TABLE ${table} (paper_id INTEGER PRIMARY KEY, status TEXT NOT NULL, source TEXT, sections_json TEXT NOT NULL,
              chars INTEGER NOT NULL, notes_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
    },
  ]);
  const hosts = context.manifest.permissions.network ?? [];
  type Row = {
    paper_id: number;
    status: FullText["status"];
    source: string | null;
    sections_json: string;
    chars: number;
    notes_json: string;
    fetched_at: string;
  };
  const toText = (r: Row): FullText => ({
    paperId: Number(r.paper_id),
    status: r.status,
    source: r.source,
    sections: JSON.parse(r.sections_json),
    chars: Number(r.chars),
    notes: JSON.parse(r.notes_json),
    fetchedAt: r.fetched_at,
  });
  const get = (paperId: number) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE paper_id = ?`).get(paperId) as Row | undefined;
    return row ? toText(row) : undefined;
  };

  const { contributions } = host.services;
  const converterViews = async (): Promise<ConverterView[]> => {
    const all = await contributions.contributionsTo("fulltext.converter", { activate: true });
    const active = contributions.activeContribution("fulltext.converter", context.settings);
    return Promise.all(
      all.map(async (contribution) => {
        let availability: { ok: boolean; reason?: string } = { ok: false, reason: "not loaded" };
        try {
          availability = (await host.exportsOf<ConverterExports>(contribution.pluginId)).available();
        } catch (error) {
          availability = { ok: false, reason: String(error) };
        }
        return {
          id: contribution.id,
          title: String(contribution.title ?? contribution.id),
          pluginId: contribution.pluginId,
          active: contribution.id === active?.id,
          available: availability.ok,
          ...(availability.reason ? { reason: availability.reason } : {}),
        };
      }),
    );
  };
  const convert: FullTextExports["convert"] = async (pdf, converterId) => {
    await contributions.contributionsTo("fulltext.converter", { activate: true });
    const choice = converterId
      ? (await contributions.contributionsTo("fulltext.converter")).find((c) => c.id === converterId)
      : contributions.activeContribution("fulltext.converter", context.settings);
    if (!choice) throw new FullTextInvalid(converterId ? `no converter ${converterId}` : "no converter is enabled");
    const converter = await host.exportsOf<ConverterExports>(choice.pluginId);
    const availability = converter.available();
    if (!availability.ok)
      throw new FullTextInvalid(`${choice.id} is not available: ${availability.reason ?? "unknown"}`);
    return converter.convert(pdf);
  };

  const fetchText = async (url: string, accept: string) => {
    const response = await rh.http.request(url, { headers: { accept }, timeoutMs: 60_000, attempts: 2 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  };
  const fetchPdf = async (url: string) => {
    const response = await rh.http.request(url, {
      headers: { accept: "application/pdf" },
      timeoutMs: 120_000,
      attempts: 2,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new Error(`the PDF is ${Math.round(bytes.length / 1e6)} MB`);
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("not a PDF");
    return bytes;
  };

  /** Each source in order; the first with sections wins. */
  const fetchFullText = async (paperId: number): Promise<FullText> => {
    const paper = papers.store.get(paperId);
    if (!paper) throw new FullTextInvalid(`no paper ${paperId}`);
    const notes: string[] = [];
    const attempts: { source: string; run: () => Promise<Section[]> }[] = [];
    const arxiv = paper.ids.arxiv?.replace(/v\d+$/, "");
    const doi = paper.ids.doi?.toLowerCase();
    if (arxiv)
      attempts.push({
        source: "arxiv-html",
        run: async () => arxivHtmlToSections(await fetchText(`https://arxiv.org/html/${arxiv}`, "text/html")),
      });
    if (paper.ids.pmcid)
      attempts.push({
        source: "europepmc-jats",
        run: async () =>
          jatsToSections(
            await fetchText(
              `https://www.ebi.ac.uk/europepmc/webservices/rest/${paper.ids.pmcid!.toUpperCase()}/fullTextXML`,
              "application/xml",
            ),
          ),
      });
    if (doi?.startsWith("10.1101/"))
      attempts.push({
        source: "biorxiv-jats",
        run: async () => {
          for (const server of ["biorxiv", "medrxiv"]) {
            const body = (await rh.http.json<{ collection?: { jatsxml?: string }[] }>(
              `https://api.biorxiv.org/details/${server}/${doi}`,
            )) ?? { collection: [] };
            const jats = body.collection?.at(-1)?.jatsxml;
            if (jats) return jatsToSections(await fetchText(jats, "application/xml"));
          }
          throw new Error("no JATS version listed");
        },
      });
    const pdfUrls = [...(arxiv ? [`https://arxiv.org/pdf/${arxiv}`] : []), ...(paper.oaUrl ? [paper.oaUrl] : [])];
    for (const url of pdfUrls) {
      const active = contributions.activeContribution("fulltext.converter", context.settings);
      attempts.push({
        source: `pdf:${active?.id ?? "none"}`,
        run: async () => {
          if (!openAccessHost(url, hosts))
            throw new Error(`${new URL(url).hostname} is not on the open-access host list`);
          return convert(await fetchPdf(url));
        },
      });
    }
    if (!attempts.length) notes.push("no arXiv id, PMCID, bioRxiv DOI or open-access link");
    let found: { source: string; sections: Section[] } | undefined;
    for (const a of attempts) {
      try {
        const sections = await a.run();
        if (sections.length >= 2) {
          found = { source: a.source, sections };
          break;
        }
        notes.push(`${a.source}: no sections found`);
      } catch (error) {
        notes.push(`${a.source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const sections = found?.sections ?? [];
    const chars = sections.reduce((n, s) => n + s.text.length, 0);
    const fetchedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO ${table} (paper_id, status, source, sections_json, chars, notes_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (paper_id) DO UPDATE SET status = excluded.status, source = excluded.source, sections_json = excluded.sections_json,
         chars = excluded.chars, notes_json = excluded.notes_json, fetched_at = excluded.fetched_at`,
    ).run(
      paperId,
      found ? "ok" : "missing",
      found?.source ?? null,
      JSON.stringify(sections),
      chars,
      JSON.stringify(notes),
      fetchedAt,
    );
    context.log.info("fulltext.fetched", { paperId, source: found?.source ?? null, sections: sections.length, chars });
    if (found) {
      rh.events.emit("fulltext.ready", { paperId });
      // Facet vectors from the sections (background, method, result).
      try {
        await papers.vectors.refresh(paperId);
      } catch (error) {
        context.log.warn("fulltext.vectors_failed", { paperId, error: String(error) });
      }
    }
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
    converters: converterViews,
    convert,
  };
}
