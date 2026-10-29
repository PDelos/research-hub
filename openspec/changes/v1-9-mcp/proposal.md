## Why

EVOLUTION.md §6 step 10: outside agents (Claude, an IDE, another hub) should be able to use a project's knowledge:
search the knowledge base and the papers it gathered, read notes and full texts, see the cards and the charter. MCP
is the standard way to offer that.

## What Changes

- **An MCP server per project** at `POST /mcp` (Streamable HTTP, stateless), on the hub's own port, behind its own
  read-only token `RH_MCP_TOKEN` (not the API token); without the token set, `/mcp` answers that MCP is off.
- **Tools (read-only):** `search_knowledge` (the knowledge base's full-text search), `read_note` (a note by stem),
  `search_papers` (semantic search over the project's papers: one embedding of the query), `get_paper` (metadata,
  the card's scores and summary, the user's judgment, and the full text when the hub has it), `recent_cards`,
  `get_charter`. Every call is logged; nothing is written.
- **An add-on** `rh.mcp` (topic integrations, on by default) holds the tools, so turning it off closes `/mcp`.
- `new-project.sh` writes an `RH_MCP_TOKEN`; the README shows how to connect Claude Code and other clients.

## Capabilities

### New Capabilities
- `mcp`: the endpoint, token, tools.

## Impact

New built-in `rh.mcp`, `src/routes-mcp.ts`, config (`RH_MCP_TOKEN`), dependency `@modelcontextprotocol/sdk` and
`zod`, `new-project.sh`, `.env.example`, README.
