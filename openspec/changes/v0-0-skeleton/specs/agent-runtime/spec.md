# Spec Delta

## Purpose

Defines the durable project agent that every later feature runs on: how users talk to it, how it
survives restarts without losing or repeating work, and how its activity and cost are recorded.

## ADDED Requirements

### Requirement: One root agent per project
Each project SHALL have exactly one long-lived root conversation, the research-desk agent, created on first start and reused afterwards.

#### Scenario: Reuse after restart
- **WHEN** the hub restarts
- **THEN** the project's root conversation is the same one as before, with its full history

### Requirement: Chat over the API
The user SHALL be able to send a message to the project agent through the API and receive the reply.

#### Scenario: Send a message
- **WHEN** a client posts a chat message for the `default` project
- **THEN** the message is accepted with HTTP 202 and the agent's reply is appended to the conversation

#### Scenario: Message while the agent is busy
- **WHEN** a message is posted while the agent is still answering an earlier one
- **THEN** the new message is queued and answered after the current turn, never dropped

### Requirement: Live event stream
The hub SHALL push conversation and run updates to clients over one server-sent event stream: a snapshot on connect, then deltas.

#### Scenario: Two clients stay in sync
- **WHEN** two browser tabs are open on the same project and one sends a message
- **THEN** both tabs show the message and the streamed reply

#### Scenario: Refresh mid-reply
- **WHEN** the page is refreshed while the agent is replying
- **THEN** the reply continues on the server and the reloaded page shows it, including the part produced before the refresh

### Requirement: Durable turns
Model turns and tool calls SHALL be committed to storage before they are shown, so a crashed process resumes from the last checkpoint.

#### Scenario: Kill during a turn
- **WHEN** the server process is killed while the agent is mid-turn and is then restarted
- **THEN** the turn completes after restart with exactly one complete reply, the conversation contains no duplicated message or tool result, and the cut-off generation is kept at most once as an empty entry marked interrupted

#### Scenario: Interrupted run is not finished
- **WHEN** the process is killed during a generation
- **THEN** the run is not reported as done until the resumed turn produces its reply

### Requirement: Idempotent side-effect tools
A tool that creates something (a record, a task, a subagent) SHALL create it at most once per tool call, even when the call is replayed after a crash.

#### Scenario: Replay after crash
- **WHEN** the process dies after such a tool ran but before the turn finished, and restarts
- **THEN** the replayed call returns the object created the first time and no second object exists

### Requirement: Restricted toolset
The agent SHALL only be able to call tools on its project's allow-list; it SHALL have no shell or file-system tools.

#### Scenario: Unknown tool
- **WHEN** the model attempts to call a tool that is not on the allow-list
- **THEN** the call is rejected with an error returned to the model and nothing is executed

### Requirement: Configurable models per job
The model used for each job (`desk`, `reader`, `review`, `chat`) SHALL come from configuration and SHALL be changeable without code changes.

#### Scenario: Switch model
- **WHEN** the configured `chat` model ID is changed and the hub is restarted
- **THEN** the next chat turn uses the new model and the run record shows the new model ID

### Requirement: Run telemetry and cost
Every agent run SHALL record its tool calls, token counts, model IDs, duration and cost, and the UI SHALL show them per run and as a project total.

#### Scenario: Cost visible
- **WHEN** a chat turn finishes
- **THEN** the Runs view lists it with its tool calls, input/output tokens and cost, and the project total increases by that cost

### Requirement: Context compaction
When a conversation's context passes the background compaction point (default 100,000 tokens), the hub SHALL compact it in the background; at the force point (default 200,000 tokens, fitted to the model's window) it SHALL compact before the next turn.

#### Scenario: Long chat
- **WHEN** a conversation crosses the background compaction point
- **THEN** a compaction runs without blocking new messages, later turns send fewer tokens, and the visible history is preserved

#### Scenario: Force point
- **WHEN** a conversation reaches the force point
- **THEN** the next turn waits for compaction to finish and then proceeds
