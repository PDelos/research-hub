// Normalization shared by every source: identifiers, titles, dates, abstract text and sentence splitting.

export type IdKind = "doi" | "arxiv" | "pmid" | "pmcid" | "openalex" | "s2";
export const ID_KINDS: readonly IdKind[] = ["doi", "arxiv", "pmid", "pmcid", "openalex", "s2"];
export type PaperIds = Partial<Record<IdKind, string>>;

/** DOI lowercased, without resolver prefix or "doi:" label. Undefined when it does not look like a DOI. */
export function normalizeDoi(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(value) ? value : undefined;
}

/** arXiv ID without the version or URL: "2401.01234", "q-bio/0601001". */
export function normalizeArxivId(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw
    .trim()
    .replace(/^https?:\/\/(export\.)?arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
  if (/^\d{4}\.\d{4,5}$/.test(value)) return value;
  if (/^[a-z-]+(\.[a-z]{2})?\/\d{7}$/i.test(value)) return value.toLowerCase();
  return undefined;
}

/** arXiv DOIs (10.48550/arxiv.<id>) name an arXiv ID too. */
export function arxivIdFromDoi(doi: string | undefined): string | undefined {
  const match = doi?.match(/^10\.48550\/arxiv\.(.+)$/);
  return match ? normalizeArxivId(match[1]) : undefined;
}

export function normalizePmid(raw: string | number | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = String(raw)
    .trim()
    .replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, "")
    .replace(/\/$/, "");
  return /^\d{1,9}$/.test(value) ? value : undefined;
}

/** PMCID with its "PMC" prefix kept (uppercase). */
export function normalizePmcid(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw
    .trim()
    .replace(/^https?:\/\/www\.ncbi\.nlm\.nih\.gov\/pmc\/articles\//i, "")
    .replace(/\/$/, "")
    .toUpperCase();
  if (/^PMC\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `PMC${value}`;
  return undefined;
}

/** OpenAlex work ID ("W2741809807"), from a bare ID or URL. */
export function normalizeOpenAlexId(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw
    .trim()
    .replace(/^https?:\/\/openalex\.org\//i, "")
    .toUpperCase();
  return /^W\d+$/.test(value) ? value : undefined;
}

export function normalizeS2Id(raw: string | null | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

/** Normalize a whole identifier set, dropping anything malformed; an arXiv DOI also yields the arXiv ID. */
export function normalizeIds(ids: PaperIds): PaperIds {
  const out: PaperIds = {};
  const doi = normalizeDoi(ids.doi);
  if (doi) out.doi = doi;
  const arxiv = normalizeArxivId(ids.arxiv) ?? arxivIdFromDoi(doi);
  if (arxiv) out.arxiv = arxiv;
  const pmid = normalizePmid(ids.pmid);
  if (pmid) out.pmid = pmid;
  const pmcid = normalizePmcid(ids.pmcid);
  if (pmcid) out.pmcid = pmcid;
  const openalex = normalizeOpenAlexId(ids.openalex);
  if (openalex) out.openalex = openalex;
  const s2 = normalizeS2Id(ids.s2);
  if (s2) out.s2 = s2;
  return out;
}

/** Title for duplicate flagging only: lowercase alphanumerics separated by single spaces. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Collapse whitespace and strip tags and common entities (Europe PMC and Crossref abstracts carry HTML/JATS). */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A YYYY-MM-DD date from an ISO timestamp or partial date ("2026", "2026-10"), or undefined. */
export function normalizeDate(raw: string | null | undefined): string | undefined {
  const match = raw?.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!match) return undefined;
  return `${match[1]}-${match[2] ?? "01"}-${match[3] ?? "01"}`;
}

// Words after which a period does not end a sentence.
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "et al",
  "al",
  "etc",
  "vs",
  "cf",
  "fig",
  "figs",
  "eq",
  "eqs",
  "ref",
  "refs",
  "approx",
  "ca",
  "resp",
  "no",
  "nos",
  "vol",
  "dr",
  "prof",
  "mr",
  "mrs",
  "ms",
  "st",
  "sp",
  "spp",
  "var",
  "sect",
  "ch",
  "inc",
  "ltd",
  "co",
  "u.s",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

/**
 * Split an abstract into sentences. A sentence ends at ".", "!" or "?" followed by whitespace and an uppercase
 * letter, digit, quote or bracket, unless the period belongs to a decimal, an abbreviation such as "e.g." or
 * "et al.", or a single capital initial. Section labels like "BACKGROUND:" stay with their sentence.
 */
export function splitSentences(text: string): string[] {
  const clean = cleanText(text);
  if (!clean) return [];
  const out: string[] = [];
  let start = 0;
  const boundary = /([.!?])["')\]]*\s+(?=["'([]?[A-Z0-9])/g;
  for (let m = boundary.exec(clean); m; m = boundary.exec(clean)) {
    if (m[1] === ".") {
      const before = clean.slice(start, m.index);
      const word = before.match(/([A-Za-z.]+)$/)?.[1]?.toLowerCase() ?? "";
      const phrase = before.match(/([A-Za-z]+ [A-Za-z]+)$/)?.[1]?.toLowerCase() ?? "";
      if (
        ABBREVIATIONS.has(word) ||
        ABBREVIATIONS.has(phrase) ||
        (/^[a-z]$/i.test(word) && /\s[A-Z]$|^[A-Z]$/.test(before))
      )
        continue;
    }
    const sentence = clean.slice(start, m.index + m[0].trimEnd().length).trim();
    if (/\p{L}/u.test(sentence)) out.push(sentence);
    start = m.index + m[0].length;
  }
  // Fragments without letters (a trailing footnote mark "1", a lone number) are not sentences.
  const rest = clean.slice(start).trim();
  if (/\p{L}/u.test(rest)) out.push(rest);
  return out;
}
