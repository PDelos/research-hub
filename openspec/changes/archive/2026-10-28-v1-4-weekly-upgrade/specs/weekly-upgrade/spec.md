## ADDED Requirements

### Requirement: Weekly run
The hub SHALL run one upgrade at most every `everyDays` (default 7) days, after the nightly run, and on request; each
run SHALL work on exactly one focus: the ranking slot, the embedder slot, or scouting add-ons; it SHALL never change
the core or how a slot is measured.

#### Scenario: Due upgrade
- **WHEN** the nightly run happens 7 days after the last upgrade
- **THEN** one upgrade run starts and its report names its focus

### Requirement: Focus choice
The focus SHALL be chosen by the Jev command `upgrade-focus` from the slots' last results and ages, the user's digest
comments since the last upgrade, the failure modes and the recent focuses; with confidence below 0.4 the focus SHALL
rotate ranking, embedder, scout-addons.

#### Scenario: Comment steers the focus
- **WHEN** the user commented "the similar-paper suggestions feel off" and Jev answers embedder with confidence 0.8
- **THEN** the run works on the embedder and its report quotes the comment as the reason

### Requirement: Ranking upgrade applied with undo
A ranking run SHALL analyze failures, replay at most 12 setting variants ordered by that analysis, and apply the one
with the verdict "better" and the highest held-out lower bound as one undoable change; with no "better" variant it
SHALL change nothing and say so.

#### Scenario: A winner is applied
- **WHEN** most 👎 reasons say "off topic" and raising `relevanceMin` to 0.5 replays as better
- **THEN** `relevanceMin` 0.5 is applied by `proposal:upgrade-<id>`, listed with Undo, and the report shows all variants tried

### Requirement: Embedder upgrade proposed
An embedder run SHALL take candidates only from OpenRouter's embedding catalog within the price limit, shortlist at
most 2 (web research, or the newest cheap models without it), benchmark them on the embedder preset within the run's
cost cap, and propose a candidate that beats the active model's mean nDCG@10 by at least 0.02 without being worse on
"your stars"; approving the proposal SHALL switch the embedder and re-embed the papers in the background without a
restart.

#### Scenario: Approve a new embedder
- **WHEN** a proposed embedder is approved
- **THEN** `rh.embedder-openrouter`'s model and dims are set (undoable), new vectors are computed in the background, and similarity search keeps working meanwhile

### Requirement: Add-on scouting
A scout run SHALL list up to 5 sources or integrations not already present, each with a name, a link and a reason,
which the user can dismiss.

#### Scenario: New source suggested
- **WHEN** a scout run finds a free biomedical paper API the hub lacks
- **THEN** it is listed with its link and why it fits the charter

### Requirement: Reports and proposals
Every run SHALL store a report (focus and reason, analysis, every candidate tried with its numbers, the result,
cost), shown in the Upgrades tab and the digest; proposals SHALL wait for the user's approve or reject.

#### Scenario: Nothing better found
- **WHEN** no candidate wins
- **THEN** the report says so with the numbers, and nothing changes
