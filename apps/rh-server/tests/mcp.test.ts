// Spec mcp: MCP endpoint, Read-only tools (v1-9 task 1.1), with the official SDK client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { validateCharter } from "../src/charter.ts";
import { cardWriterRule, librarianRule } from "../src/faux-rules.ts";
import { sampleCharter } from "./fixtures/charter.ts";
import { byId, noul, pick, score, scripted } from "./fixtures/jev-answers.ts";
import { arxivOnlyFetch, fakePapers } from "./fixtures/sweep-env.ts";
import { startTestServer, TOKEN } from "./test-server.ts";

const MCP_TOKEN = "mcp-test-token-0123456789";

async function connect(url: string, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
const textOf = (r: any) => (r.content as { text: string }[])[0].text;

test("an MCP client lists the read-only tools and reads the knowledge base, papers, cards and charter", async () => {
  const server = await startTestServer({
    env: { RH_MCP_TOKEN: MCP_TOKEN },
    hub: {
      ticker: false,
      fauxRules: [cardWriterRule, librarianRule],
      jevDecide: scripted(byId({ relevance: score(0.75, 5), matched_question: pick("Q1"), worth: noul(0.8) })).decide,
      paperFetch: arxivOnlyFetch(fakePapers(3)),
    },
  });
  const projectRuntime = server.hub.project;
  try {
    projectRuntime.brief.write("# Protein LMs");
    projectRuntime.charters.saveDraft(validateCharter(sampleCharter()), "agent");
    projectRuntime.charters.approve();
    projectRuntime.syncVault();
    projectRuntime.scheduler.trigger("sweep");
    for (let i = 0; i < 500 && !projectRuntime.sweeps.list()[0]; i++) await new Promise((r) => setTimeout(r, 10));
    await projectRuntime.sweeps.settled(projectRuntime.sweeps.list()[0].id, 30_000);
    const card = projectRuntime.cards.list()[0];
    projectRuntime.feedback.judge(card.id, "star", "Exactly the foundation I need");
    for (let i = 0; i < 1000 && !projectRuntime.ingest.requests().some((r: any) => r.status === "done"); i++)
      await new Promise((r) => setTimeout(r, 20));

    const client = await connect(server.url, MCP_TOKEN);
    const tools = (await client.listTools()).tools.map((t) => t.name).toSorted();
    assert.deepEqual(tools, [
      "get_charter",
      "get_paper",
      "read_note",
      "recent_cards",
      "search_knowledge",
      "search_papers",
    ]);

    const hits = JSON.parse(
      textOf(await client.callTool({ name: "search_knowledge", arguments: { query: "protein" } })),
    );
    assert.ok(hits.length >= 1);
    const note = textOf(await client.callTool({ name: "read_note", arguments: { stem: hits[0].stem } }));
    assert.ok(note.length > 20 && !note.startsWith("No note"), note);
    const papers = JSON.parse(
      textOf(
        await client.callTool({ name: "search_papers", arguments: { query: "protein language models", limit: 3 } }),
      ),
    );
    assert.equal(papers.length, 3);
    const paper = JSON.parse(
      textOf(await client.callTool({ name: "get_paper", arguments: { paper_id: card.paperId, full_text: true } })),
    );
    assert.equal(paper.your_judgment, "star");
    assert.equal(paper.card.reason, "Exactly the foundation I need");
    assert.equal(paper.full_text, "not available");
    const cards = JSON.parse(textOf(await client.callTool({ name: "recent_cards", arguments: { limit: 2 } })));
    assert.equal(cards.length, 2);
    const charter = JSON.parse(textOf(await client.callTool({ name: "get_charter", arguments: {} })));
    assert.equal(charter.version, 1);
    assert.equal(charter.questions.length, 3);
    const bad = await client.callTool({ name: "get_paper", arguments: { paper_id: -1 } }).catch((e) => e);
    assert.ok(bad instanceof Error || (bad as any).isError, "validated input");
    await client.close();
    assert.ok(server.logs.some((l) => l.includes('"mcp.call"') && l.includes("search_papers")));
    assert.ok(!server.logs.some((l) => l.includes(MCP_TOKEN)), "the token is never logged");

    // The API token is not the MCP token; disabling the add-on closes /mcp.
    await assert.rejects(connect(server.url, TOKEN), /401|valid MCP token/);
    await projectRuntime.plugins.kernel.setEnabled("rh.mcp", false);
    await assert.rejects(connect(server.url, MCP_TOKEN), /404|disabled/);
    const get = await fetch(`${server.url}/mcp`);
    assert.equal(get.status, 405);
  } finally {
    await server.stop();
  }
});

test("without RH_MCP_TOKEN the endpoint says MCP is off", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, /set RH_MCP_TOKEN/);
  } finally {
    await server.stop();
  }
});
