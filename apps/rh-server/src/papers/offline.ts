// Offline mode (RH_MODE=offline) makes no network calls, so paper search answers from this deterministic fetch:
// synthetic arXiv, OpenAlex and Europe PMC responses built from the query, in each API's real format, so the same
// parsing, merging, enrichment and representation code runs as in live mode. Every third arXiv paper also appears
// in OpenAlex with the same DOI (a merge), and OpenAlex knows every arXiv DOI except every fifth (pending enrichment).
import { createHash } from "node:crypto";

const METHODS = [
  "a graph neural network over residue contacts",
  "a fine-tuned protein language model with a contact head",
  "contrastive pretraining on single-cell expression profiles",
  "a diffusion model conditioned on sequence embeddings",
  "a transformer with axial attention over alignments",
];
const FINDINGS = [
  "improves precision by 12%",
  "matches the best baseline with 40% fewer parameters",
  "raises recall from 0.61 to 0.74",
  "generalizes to unseen protein families",
  "reduces error by 18% on held-out data",
];
const AUTHORS = [
  "Ada Rivera",
  "Ben Okafor",
  "Chen Wei",
  "Dana Novak",
  "Eli Haddad",
  "Fatima Zahra",
  "Goran Petrov",
  "Hana Sato",
];

interface Synthetic {
  arxiv: string;
  doi: string;
  title: string;
  abstract: string;
  authors: string[];
  date: string;
}

function hashInt(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

function corpus(query: string, prefix: string, count: number, today: Date): Synthetic[] {
  const topic =
    query
      .replace(/["()]/g, "")
      .replace(/\b(AND|OR|NOT)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "the topic";
  return Array.from({ length: count }, (_, i) => {
    const hash = hashInt(`${prefix}:${topic}:${i}`);
    const method = METHODS[hash % METHODS.length];
    const finding = FINDINGS[(hash >>> 8) % FINDINGS.length];
    const date = new Date(today.getTime() - ((hash >>> 16) % 28) * 86_400_000).toISOString().slice(0, 10);
    const arxiv = `${date.slice(2, 4)}${date.slice(5, 7)}.${String(hash % 100_000).padStart(5, "0")}`;
    return {
      arxiv,
      doi: `10.48550/arxiv.${arxiv}`,
      title: `${topic[0].toUpperCase()}${topic.slice(1)} with ${method.replace(/^an? /, "")} (${prefix} ${i + 1})`,
      abstract:
        `Progress on ${topic} is limited by scarce labeled data and noisy measurements. ` +
        `We propose ${method} trained on public data for ${topic}. ` +
        `On standard benchmarks our approach ${finding}. ` +
        `Code is available online.`,
      authors: [AUTHORS[hash % AUTHORS.length], AUTHORS[(hash >>> 4) % AUTHORS.length]].filter(
        (a, k, all) => all.indexOf(a) === k,
      ),
      date,
    };
  });
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function arxivFeed(papers: Synthetic[]): string {
  const entries = papers
    .map(
      (
        p,
      ) => `<entry><id>http://arxiv.org/abs/${p.arxiv}v1</id><title>${escape(p.title)}</title><summary>${escape(p.abstract)}</summary>
<published>${p.date}T12:00:00Z</published>${p.authors.map((a) => `<author><name>${a}</name></author>`).join("")}
<link href="https://arxiv.org/pdf/${p.arxiv}v1" rel="related" type="application/pdf" title="pdf"/></entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entries}</feed>`;
}

function invertedIndex(text: string): Record<string, number[]> {
  const index: Record<string, number[]> = {};
  text.split(" ").forEach((w, i) => (index[w] ??= []).push(i));
  return index;
}

function openalexWork(synthetic: Synthetic, venue: string | null, references: string[]) {
  const id = `W${hashInt(synthetic.doi) % 1_000_000_000}`;
  return {
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/${synthetic.doi}`,
    ids: { openalex: `https://openalex.org/${id}`, doi: `https://doi.org/${synthetic.doi}` },
    display_name: synthetic.title,
    publication_date: synthetic.date,
    publication_year: Number(synthetic.date.slice(0, 4)),
    authorships: synthetic.authors.map((a) => ({ author: { display_name: a } })),
    primary_location: venue
      ? { landing_page_url: `https://doi.org/${synthetic.doi}`, source: { display_name: venue, type: "journal" } }
      : {
          landing_page_url: `https://arxiv.org/abs/${synthetic.arxiv}`,
          source: { display_name: "arXiv (Cornell University)", type: "repository" },
        },
    best_oa_location: { pdf_url: `https://arxiv.org/pdf/${synthetic.arxiv}` },
    cited_by_count: hashInt(id) % 50,
    referenced_works: references,
    referenced_works_count: references.length,
    is_retracted: false,
    abstract_inverted_index: invertedIndex(synthetic.abstract),
  };
}

/** Shared references among offline works, so citation reports have something to show. */
const REFERENCES = [
  "https://openalex.org/W100",
  "https://openalex.org/W101",
  "https://openalex.org/W102",
  "https://openalex.org/W103",
];

export function offlinePaperFetch(today: () => Date = () => new Date()): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const searchParams = url.searchParams;
    if (url.host === "export.arxiv.org") {
      const query = (searchParams.get("search_query") ?? "")
        .replace(/all:/g, "")
        .replace(/ AND submittedDate:\[.*\]$/, "")
        .replace(/ AND /g, " ");
      return new Response(
        arxivFeed(corpus(query, "arXiv", Math.min(Number(searchParams.get("max_results") ?? 5), 10), today())),
        {
          headers: { "content-type": "application/atom+xml" },
        },
      );
    }
    if (url.host === "api.openalex.org" && url.pathname === "/works") {
      const filter = searchParams.get("filter") ?? "";
      if (filter.startsWith("doi:")) {
        // Enrichment lookups: known unless the DOI hashes to a multiple of five (not indexed yet).
        const results = filter
          .slice(4)
          .split("|")
          .filter((doi) => hashInt(doi) % 5 !== 0)
          .map((doi) => {
            const arxiv = doi.replace(/^10\.48550\/arxiv\./, "");
            return openalexWork(
              { arxiv, doi, title: `Offline work ${arxiv}`, abstract: "", authors: [], date: "2026-01-01" },
              null,
              REFERENCES.slice(0, 3),
            );
          });
        return Response.json({ results });
      }
      const search = searchParams.get("search") ?? "";
      const perPage = Math.min(Number(searchParams.get("per-page") ?? 5), 10);
      // Every third arXiv paper reappears here as a journal version with the same DOI.
      const arxiv = corpus(search, "arXiv", perPage, today()).filter((_, i) => i % 3 === 0);
      const own = corpus(search, "OpenAlex", perPage - arxiv.length, today());
      return Response.json({
        results: [
          ...arxiv.map((w) => openalexWork(w, "Bioinformatics", REFERENCES.slice(0, 3))),
          ...own.map((w) => openalexWork(w, "Nature Methods", REFERENCES.slice(1))),
        ],
      });
    }
    if (url.host === "api.openalex.org") return new Response("", { status: 404 });
    if (url.host === "www.ebi.ac.uk") {
      const query = (searchParams.get("query") ?? "").replace(/ AND FIRST_PDATE:\[.*\]$/, "");
      const papers = corpus(query, "bioRxiv", Math.min(Number(searchParams.get("pageSize") ?? 5), 10), today());
      return Response.json({
        resultList: {
          result: papers.map((w, i) => ({
            id: `PPR${hashInt(w.title) % 1_000_000}`,
            source: "PPR",
            doi: `10.1101/${w.date.replace(/-/g, ".")}.${String(600000 + i)}`,
            title: w.title,
            abstractText: w.abstract,
            authorList: { author: w.authors.map((fullName) => ({ fullName })) },
            pubYear: w.date.slice(0, 4),
            firstPublicationDate: w.date,
            bookOrReportDetails: { publisher: "bioRxiv" },
            citedByCount: 0,
          })),
        },
      });
    }
    return new Response("offline mode: no network", { status: 503 });
  }) as typeof fetch;
}
