## ADDED Requirements

### Requirement: MCP endpoint
Each project SHALL offer an MCP server at `POST /mcp` (Streamable HTTP) behind its own read-only token
`RH_MCP_TOKEN`; without the token, or with the `rh.mcp` add-on disabled, the endpoint SHALL refuse with the reason.

#### Scenario: Wrong token
- **WHEN** a client calls /mcp with the API token instead of the MCP token
- **THEN** it is refused with 401 and nothing is read

### Requirement: Read-only tools
The MCP server SHALL offer search_knowledge, read_note, search_papers, get_paper, recent_cards and get_charter, all
read-only, each call logged.

#### Scenario: An agent searches the knowledge base
- **WHEN** an MCP client lists the tools and calls search_knowledge with "contact maps"
- **THEN** it receives the matching notes with their stems and excerpts
