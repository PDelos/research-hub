// Europe PMC: keyless search over journal articles and preprints; bioRxiv/medRxiv preprints arrive as SRC:PPR with
// the server in bookOrReportDetails.publisher. Requests carry email=CONTACT_EMAIL.
import { cleanText, normalizeDate, normalizeIds } from "../normalize.ts";
import type { SourcePaper } from "../store.ts";
import { serverName } from "./openalex.ts";
import { inWindow, queryTerms, type PaperSource, type SourceDeps, type SourceQuery } from "./types.ts";

export const EUROPEPMC_API = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

export class EuropePmcSource implements PaperSource {
  readonly name = "europepmc" as const;
  constructor(private readonly deps: SourceDeps) {}

  async search(sourceQuery: SourceQuery): Promise<SourcePaper[]> {
    const terms = queryTerms(sourceQuery.query);
    if (!terms.length) return [];
    let query = `(${terms.join(" AND ")})`;
    if (sourceQuery.since || sourceQuery.until)
      query += ` AND FIRST_PDATE:[${sourceQuery.since ?? "1900-01-01"} TO ${sourceQuery.until ?? "2999-12-31"}]`;
    const params = new URLSearchParams({
      query,
      resultType: "core",
      format: "json",
      pageSize: String(Math.min(sourceQuery.limit, 100)),
    });
    if (this.deps.http.contactEmail) params.set("email", this.deps.http.contactEmail);
    const body = await this.deps.http.json<{ resultList?: { result?: any[] } }>(`${EUROPEPMC_API}?${params}`, {
      source: this.name,
      budgetMs: sourceQuery.budgetMs,
    });
    return (body.resultList?.result ?? [])
      .map(mapEuropePmcRecord)
      .filter((p): p is SourcePaper => !!p && inWindow(p.publishedAt, sourceQuery.since, sourceQuery.until));
  }
}

/** A preprint ("PPR") names its server as the publisher; anything else has a journal. */
function hostOf(record: any): { venue: string | undefined; server: string | undefined } {
  if (record.source === "PPR") return { venue: undefined, server: serverName(record.bookOrReportDetails?.publisher) };
  return { venue: cleanText(record.journalInfo?.journal?.title) || undefined, server: undefined };
}

export function mapEuropePmcRecord(record: any): SourcePaper | null {
  const title = cleanText(record?.title).replace(/\.$/, "");
  if (!title || !record.id) return null;
  const authors = ((record.authorList?.author ?? []) as any[])
    .map((a) => cleanText(a.fullName ?? a.collectiveName))
    .filter(Boolean);
  const free = ((record.fullTextUrlList?.fullTextUrl ?? []) as any[]).find(
    (u) => u.availabilityCode === "OA" || u.availabilityCode === "F",
  );
  return {
    source: "europepmc",
    externalId: `${record.source}:${record.id}`,
    ids: normalizeIds({ doi: record.doi, pmid: record.pmid, pmcid: record.pmcid }),
    title,
    abstract: abstractText(record.abstractText),
    authors: authors.length ? authors : splitAuthorString(record.authorString),
    year: record.pubYear ? Number(record.pubYear) : undefined,
    publishedAt: normalizeDate(record.firstPublicationDate),
    ...hostOf(record),
    oaUrl: free?.url,
    url: `https://europepmc.org/article/${record.source}/${record.id}`,
    citedByCount: typeof record.citedByCount === "number" ? record.citedByCount : undefined,
  };
}

/** Section headings ("<h4>Introduction</h4>") become "Introduction: " so they stay with their sentence. */
function abstractText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = cleanText(raw.replace(/<h\d[^>]*>\s*([^<]+?)\s*<\/h\d>/gi, " $1: "));
  return text || undefined;
}

/** "Smith J, Doe A." → ["Smith J", "Doe A"]; nothing → []. */
function splitAuthorString(authorString: unknown): string[] {
  if (!authorString) return [];
  return String(authorString).replace(/\.$/, "").split(/,\s*/);
}
