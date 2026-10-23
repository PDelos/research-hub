// Serve recorded source responses by URL; records every request for assertions.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const fixture = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

export type Route = (url: URL) => Response | Promise<Response> | undefined;

export function fakeFetch(...routes: Route[]) {
  const requests: { url: URL; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    for (const route of routes) {
      const response = await route(url);
      if (response) return response;
    }
    return new Response(`no fixture for ${url}`, { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

/** Routes for the recorded responses of the three keyless sources. */
export const recorded: Route = (url) => {
  if (url.host === "export.arxiv.org") return new Response(fixture("arxiv-search.xml"), { headers: { "content-type": "application/atom+xml" } });
  if (url.host === "api.openalex.org" && url.pathname === "/works" && url.searchParams.has("search"))
    return new Response(fixture("openalex-search.json"), { headers: { "content-type": "application/json" } });
  if (url.host === "www.ebi.ac.uk") {
    const name = url.searchParams.get("query")?.includes("SRC:MED") ? "europepmc-journal.json" : "europepmc-search.json";
    return new Response(fixture(name), { headers: { "content-type": "application/json" } });
  }
  return undefined;
};
