// Where a paper's full text can be read, best first: arXiv HTML, Europe PMC JATS, bioRxiv/medRxiv JATS, then a PDF
// from an open-access host through the active converter. The first source that yields sections wins.
import { arxivHtmlToSections, jatsToSections, type Section } from "../../src/fulltext/parse.ts";
import type { RhApi } from "../../src/kernel/api.ts";
import type { Paper } from "../../src/papers/store.ts";
import { hostAllowed } from "../../src/kernel/permissions.ts";

export const MAX_PDF_BYTES = 40_000_000;

/** Hosts whose open-access links are fetched (the manifest lists the same ones). */
export function openAccessHost(url: string, hosts: readonly string[]): boolean {
  try {
    return hostAllowed(hosts, new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface Attempt {
  source: string;
  run: () => Promise<Section[]>;
}

export interface SourceDeps {
  http: RhApi["http"];
  /** Hosts a PDF may come from (the plugin's network permission). */
  hosts: readonly string[];
  convert: (pdf: Uint8Array) => Promise<Section[]>;
  /** The converter a PDF would go through, for the attempt's name. */
  activeConverter: () => string | undefined;
}

async function fetchText(http: RhApi["http"], url: string, accept: string): Promise<string> {
  const response = await http.request(url, { headers: { accept }, timeoutMs: 60_000, attempts: 2 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** A PDF of at most MAX_PDF_BYTES that starts like one. */
async function fetchPdf(http: RhApi["http"], url: string): Promise<Uint8Array> {
  const response = await http.request(url, { headers: { accept: "application/pdf" }, timeoutMs: 120_000, attempts: 2 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) throw new Error(`the PDF is ${Math.round(bytes.length / 1e6)} MB`);
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("not a PDF");
  return bytes;
}

/** A bioRxiv or medRxiv DOI: the newest JATS version the server lists. */
async function biorxivSections(http: RhApi["http"], doi: string): Promise<Section[]> {
  for (const server of ["biorxiv", "medrxiv"]) {
    const body = (await http.json<{ collection?: { jatsxml?: string }[] }>(
      `https://api.biorxiv.org/details/${server}/${doi}`,
    )) ?? { collection: [] };
    const jats = body.collection?.at(-1)?.jatsxml;
    if (jats) return jatsToSections(await fetchText(http, jats, "application/xml"));
  }
  throw new Error("no JATS version listed");
}

/** A PDF from an open-access host, through the active converter. */
function pdfAttempt(deps: SourceDeps, url: string): Attempt {
  return {
    source: `pdf:${deps.activeConverter() ?? "none"}`,
    run: async () => {
      if (!openAccessHost(url, deps.hosts))
        throw new Error(`${new URL(url).hostname} is not on the open-access host list`);
      return deps.convert(await fetchPdf(deps.http, url));
    },
  };
}

/** The sources a paper can be read from, best first. */
export function attemptsFor(deps: SourceDeps, paper: Paper): Attempt[] {
  const { http } = deps;
  const attempts: Attempt[] = [];
  const arxiv = paper.ids.arxiv?.replace(/v\d+$/, "");
  const doi = paper.ids.doi?.toLowerCase();
  const pmcid = paper.ids.pmcid?.toUpperCase();
  if (arxiv)
    attempts.push({
      source: "arxiv-html",
      run: async () => arxivHtmlToSections(await fetchText(http, `https://arxiv.org/html/${arxiv}`, "text/html")),
    });
  if (pmcid)
    attempts.push({
      source: "europepmc-jats",
      run: async () =>
        jatsToSections(
          await fetchText(
            http,
            `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
            "application/xml",
          ),
        ),
    });
  if (doi?.startsWith("10.1101/")) attempts.push({ source: "biorxiv-jats", run: () => biorxivSections(http, doi) });
  const pdfUrls = [...(arxiv ? [`https://arxiv.org/pdf/${arxiv}`] : []), ...(paper.oaUrl ? [paper.oaUrl] : [])];
  return [...attempts, ...pdfUrls.map((url) => pdfAttempt(deps, url))];
}

/** The first attempt that finds at least two sections; every miss leaves a note. */
export async function firstWithSections(
  attempts: Attempt[],
  notes: string[],
): Promise<{ source: string; sections: Section[] } | undefined> {
  for (const attempt of attempts) {
    try {
      const sections = await attempt.run();
      if (sections.length >= 2) return { source: attempt.source, sections };
      notes.push(`${attempt.source}: no sections found`);
    } catch (error) {
      notes.push(`${attempt.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}
