## Decisions

### D1. Transport and auth
The SDK's `StreamableHTTPServerTransport` without sessions (a new server and transport per request), mounted at
`POST /mcp`; `GET` and `DELETE` answer 405. Auth: `Authorization: Bearer <RH_MCP_TOKEN>` compared in constant time;
the token is redacted from logs. If `RH_MCP_TOKEN` is unset or `rh.mcp` is disabled, `/mcp` answers 404 with the
reason. The port is published on 127.0.0.1 only (compose), so clients run on the same machine or through a tunnel the
user sets up.

### D2. Tools
Inputs validated with zod; outputs are text (JSON for structured results), capped at 20,000 characters.
`search_knowledge { query, limit ≤ 20 }`; `read_note { stem }` (sources, concepts, questions); `search_papers
{ query, limit ≤ 20 }` via `PaperVectors.similar({ text })`; `get_paper { paper_id, full_text? }`; `recent_cards
{ limit ≤ 30 }`; `get_charter {}`. Each call logs `mcp.call` with the tool name.
