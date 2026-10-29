// The engineer's paper-source builder (spec engineer: Paper-source plugins; design v1-8 D3): the model writes an
// external plugin from a fixed template; the hub fixes its manifest (id, kind, the one network host) so the model
// cannot grant itself more, and checks a real search's results.
export const ENGINEER_BUILD_MARKER = "engineer-build";

export const BUILD_SYSTEM = `You are the ${ENGINEER_BUILD_MARKER} of a research hub: you write one small external plugin, an ES module main.mjs, that adds a scholarly paper source. Contract:

export async function activate({ rh }) {
  return { sources: { "<SOURCE_ID>": { name: "<SOURCE_ID>", search: async (q) => [ /* papers */ ] } } };
}

q = { query: string, limit: number, since?: "YYYY-MM-DD", until?: "YYYY-MM-DD" }. Use only rh.http.json(url, { headers }) or rh.http.text(url) for requests (plain fetch is blocked), only to the API's host, and return at most q.limit papers, each:
{ source: "<SOURCE_ID>", externalId: string, ids: { doi?: string, arxiv?: string, pmid?: string, pmcid?: string }, title: string, abstract?: string, authors: string[], year?: number, publishedAt?: "YYYY-MM-DD", venue?: string, url?: string }.
Skip records without a title. The module must not contain any import or require statement (URLSearchParams, encodeURIComponent and JSON are globals), no top-level await, no API keys. Answer with the whole main.mjs in one fenced code block (\`\`\`js … \`\`\`) and nothing else after it.`;

/**
 * The module from the model's answer: the text between code fences that holds `export … activate` (models sometimes
 * open with a doubled fence), else a JSON {"main": …}, else the answer itself when it is the module.
 */
export function extractMain(text: string): string {
  if (text.trim().startsWith("{"))
    try {
      const main = (JSON.parse(text.trim()) as { main?: unknown }).main;
      if (typeof main === "string") return main;
    } catch {
      // not JSON
    }
  const segments = text.split(/^\s*```[a-z]*\s*$/m).map((x) => x.trim());
  return segments.find((x) => /export\s+(async\s+)?function\s+activate/.test(x)) ?? "";
}

export interface BuiltPlugin {
  manifest: Record<string, unknown>;
  main: string;
}

/** A slug for ids: lowercase letters, digits and dashes. */
export function slug(text: string, max = 30): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "source"
  );
}

/** The manifest the hub writes (never the model's): one source contribution, one network host. */
export function sourceManifest(opts: {
  id: string;
  name: string;
  sourceId: string;
  host: string;
  description: string;
}) {
  return {
    id: opts.id,
    version: "0.1.0",
    displayName: opts.name,
    kind: "addon",
    topic: "finding",
    description: opts.description.slice(0, 300),
    engines: { "research-hub": "^1.0.0" },
    main: "main.mjs",
    activationEvents: ["onExtensionPoint:papers.source"],
    contributes: { "papers.source": [{ id: opts.sourceId, title: opts.name }] },
    permissions: { network: [opts.host] },
  };
}

/** Problems with a search's results ([] when they pass the contract test). */
export function contractProblems(papers: unknown, sourceId: string, limit: number): string[] {
  if (!Array.isArray(papers)) return [`search returned ${typeof papers}, not an array of papers`];
  if (!papers.length) return ["search returned no papers for a common query"];
  const problems: string[] = [];
  if (papers.length > limit) problems.push(`search returned ${papers.length} papers, more than the limit ${limit}`);
  papers.slice(0, 5).forEach((p: any, i) => {
    if (!p || typeof p !== "object") return void problems.push(`paper ${i}: not an object`);
    if (typeof p.title !== "string" || !p.title.trim()) problems.push(`paper ${i}: no title`);
    if (p.source !== sourceId)
      problems.push(`paper ${i}: source must be "${sourceId}", got ${JSON.stringify(p.source)}`);
    if (typeof p.externalId !== "string" || !p.externalId) problems.push(`paper ${i}: no externalId`);
    if (!Array.isArray(p.authors)) problems.push(`paper ${i}: authors must be an array`);
    const ids = p.ids && typeof p.ids === "object" ? Object.values(p.ids).filter(Boolean) : [];
    if (!ids.length && !p.url) problems.push(`paper ${i}: needs an identifier (doi, arxiv, pmid, pmcid) or a url`);
  });
  return problems;
}

/** Static checks before running: the module shape, no imports, no plain fetch. */
export function codeProblems(main: string, sourceId: string): string[] {
  const problems: string[] = [];
  if (!/export\s+(async\s+)?function\s+activate/.test(main))
    problems.push("main.mjs must export async function activate({ rh })");
  const imports = main.split("\n").filter((l) => /^\s*import[\s{*"']/.test(l) || /\brequire\(/.test(l));
  if (imports.length)
    problems.push(
      `main.mjs must not import anything; remove: ${imports
        .map((l) => l.trim())
        .join(" | ")
        .slice(0, 300)}`,
    );
  if (/(^|[^.\w])fetch\(/.test(main)) problems.push("use rh.http.json or rh.http.text, not fetch");
  if (!main.includes(sourceId)) problems.push(`the source id "${sourceId}" must appear in sources`);
  return problems;
}
