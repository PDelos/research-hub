// Full text as sections (spec full-text; design v1-6 D1, D3): parsers for arXiv's LaTeXML HTML, JATS XML (Europe PMC,
// bioRxiv), Docling's markdown and plain PDF text. Every parser drops references; sections keep their order.
import { parse, type HTMLElement } from "node-html-parser";

export interface Section {
  title: string;
  text: string;
}

export const MAX_SECTIONS = 60;
export const MAX_SECTION_CHARS = 20_000;

const clean = (s: string) =>
  s
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

const REFERENCES = /^(references|bibliography|literature cited|references and notes)$/i;

/** Normalize, drop empty and reference sections, cap the count and sizes. */
export function finish(sections: Section[]): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    const title = clean(s.title).replace(/\n/g, " ").slice(0, 200);
    if (REFERENCES.test(title.replace(/^[\dIVX.]+\s*/, ""))) break;
    const text = clean(s.text).slice(0, MAX_SECTION_CHARS);
    if (!text) continue;
    out.push({ title: title || "Untitled", text });
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

/** The text of an element with math replaced by its TeX (alttext) and citations' brackets kept. */
function textOf(element: HTMLElement): string {
  for (const m of element.querySelectorAll("math")) m.replaceWith(` ${m.getAttribute("alttext") ?? ""} `);
  for (const a of element.querySelectorAll(".ltx_note, .ltx_tag_note")) a.remove();
  return element.textContent;
}

/** arXiv's LaTeXML HTML: the abstract, then each top-level section with its paragraphs (appendices dropped). */
export function arxivHtmlToSections(html: string): Section[] {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false } });
  const sections: Section[] = [];
  const abstract = root.querySelector(".ltx_abstract");
  if (abstract) {
    abstract.querySelector("h6, .ltx_title")?.remove();
    sections.push({ title: "Abstract", text: textOf(abstract) });
  }
  for (const sec of root.querySelectorAll("section.ltx_section")) {
    const heading = sec.querySelector(".ltx_title_section");
    heading?.querySelector(".ltx_tag")?.remove();
    const paras = sec.querySelectorAll(".ltx_para").map((p) => textOf(p).trim());
    sections.push({ title: heading?.textContent ?? "", text: paras.join("\n") });
  }
  return finish(sections);
}

/** JATS (Europe PMC, bioRxiv): the abstract, then each top-level `sec` of the body with nested sections flattened. */
export function jatsToSections(xml: string): Section[] {
  const root = parse(xml.replace(/<!DOCTYPE[^>]*>/i, ""), {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: {},
  });
  const sections: Section[] = [];
  const abstract = root.querySelector("front abstract") ?? root.querySelector("abstract");
  if (abstract) {
    abstract.querySelector("title")?.remove();
    sections.push({ title: "Abstract", text: paragraphs(abstract).join("\n") });
  }
  const body = root.querySelector("body");
  if (body)
    for (const sec of body.childNodes.filter((n): n is HTMLElement => (n as HTMLElement).tagName === "SEC")) {
      const title = sec.childNodes.find((n) => (n as HTMLElement).tagName === "TITLE") as HTMLElement | undefined;
      sections.push({ title: title?.textContent ?? "", text: paragraphs(sec).join("\n") });
    }
  return finish(sections);
}

function paragraphs(element: HTMLElement): string[] {
  for (const x of element.querySelectorAll("xref, table-wrap, fig, disp-formula")) {
    if (x.tagName === "XREF") x.replaceWith(x.textContent);
    else x.remove();
  }
  return element.querySelectorAll("p").map((p) => p.textContent.trim());
}

/** Docling's markdown: split at `#` and `##` headings (deeper headings stay in their section). */
export function markdownToSections(md: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: "", text: "" };
  for (const line of md.split("\n")) {
    const heading = line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (current.text.trim() || current.title) sections.push(current);
      current = { title: heading[1].replace(/^[\dIVX]+(\.\d+)*\.?\s+/, (m) => m), text: "" };
    } else if (!/^<!--.*-->$/.test(line.trim())) current.text += `${line}\n`;
  }
  sections.push(current);
  return finish(sections.filter((s) => s.title || s.text.trim()));
}

const KNOWN_HEADINGS =
  /^(abstract|introduction|background|related work|preliminaries|motivation|methods?|materials and methods|methodology|approach|model|experimental setup|experiments?|results|results and discussion|evaluation|discussion|conclusions?|limitations|acknowledg(e)?ments|references|bibliography)$/i;
const NUMBERED = /^((\d{1,2}(\.\d{1,2}){0,2})|([IVX]{1,4}))\.?\s+([A-Z][^.!?]{1,85})$/;

/** Is this PDF line a section heading? Numbered top-level ("2 Methods", "II. RESULTS") or a known name. */
export function headingOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length > 90 || trimmed.length < 4) return undefined;
  if (KNOWN_HEADINGS.test(trimmed)) return trimmed;
  const match = trimmed.match(NUMBERED);
  if (!match) return undefined;
  // Subsections (2.1) stay inside their section; a numbered line ending in a digit is likely a table row.
  if (match[3] || /\d$/.test(trimmed) || /^0\b/.test(trimmed)) return undefined;
  // Affiliations and sentences ("2. Department of Physics, University of …") are not headings.
  if (/[,@;]/.test(match[5]) || match[5].split(/\s+/).length > 10) return undefined;
  return trimmed;
}

/**
 * PDF text per page → sections: lines repeated on 3+ pages (running headers, footers) dropped, hyphenated line ends
 * joined, headings found by {@link headingOf}; text after References dropped by {@link finish}.
 */
export function pdfTextToSections(pages: string[]): Section[] {
  const counts = new Map<string, number>();
  for (const page of pages)
    for (const line of new Set(page.split("\n").map((l) => l.trim())))
      if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  const repeated = (l: string) => pages.length >= 3 && (counts.get(l) ?? 0) >= 3 && !headingOf(l);
  const sections: Section[] = [];
  let current: Section = { title: "Front matter", text: "" };
  for (const page of pages)
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (!line || repeated(line) || /^\d{1,3}$/.test(line)) continue;
      const heading = headingOf(line);
      if (heading) {
        sections.push(current);
        current = { title: heading, text: "" };
        continue;
      }
      current.text =
        current.text.endsWith("-") && /^[a-z]/.test(line)
          ? current.text.slice(0, -1) + line
          : `${current.text}${current.text ? "\n" : ""}${line}`;
    }
  sections.push(current);
  return finish(sections.map((s) => ({ ...s, text: s.text.replace(/\n(?=[a-z(])/g, " ") })));
}

export const FACET_OF_HEADING: [RegExp, "background" | "method" | "result"][] = [
  [/introduction|background|related work|motivation|preliminar|^main$/i, "background"],
  [/method|approach|model|materials|setup|data(set)?s?\b|architecture|implementation/i, "method"],
  [/result|experiment|evaluation|discussion|conclusion|benchmark|analysis/i, "result"],
];

/**
 * Group sections into facets by their headings. Sections with no facet keyword between the first background section
 * and the first result section are the paper's own method ("Flexible protein sequence kernels"); others are left out.
 */
export function facetTexts(
  sections: Section[],
  max = 6_000,
): Partial<Record<"background" | "method" | "result", string>> {
  const out: Partial<Record<"background" | "method" | "result", string>> = {};
  const facets = sections.map((s) => FACET_OF_HEADING.find(([re]) => re.test(s.title))?.[1]);
  const firstBackground = facets.indexOf("background");
  const firstResult = facets.indexOf("result");
  sections.forEach((section, i) => {
    const facet =
      facets[i] ??
      (firstBackground >= 0 &&
      i > firstBackground &&
      (firstResult < 0 || i < firstResult) &&
      !/abstract/i.test(section.title)
        ? "method"
        : undefined);
    if (!facet) return;
    out[facet] = `${out[facet] ? `${out[facet]}\n` : ""}${section.text}`.slice(0, max);
  });
  return out;
}

/** Sections as one text within a budget: every section's head kept, longest trimmed first. */
export function withinBudget(sections: Section[], budget = 24_000): string {
  const per = Math.max(400, Math.floor(budget / Math.max(1, sections.length)));
  return sections
    .map((s) => `## ${s.title}\n${s.text.length > per ? `${s.text.slice(0, per)} …` : s.text}`)
    .join("\n\n")
    .slice(0, budget);
}
