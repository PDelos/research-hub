# knowledge-vault Specification

## Purpose
Defines the project's knowledge base as an Obsidian-compatible markdown vault: how starred papers become
connected evidence notes, how user edits are protected, and how the vault is searched and seen by the agent.

## Requirements

### Requirement: Vault layout
The project SHALL have a vault folder (`$RH_DATA_DIR/vault/`) containing `index.md`, `log.md`, `charter.md` and the folders `sources/`, `concepts/` and `questions/`, readable as an Obsidian vault.

#### Scenario: New project vault
- **WHEN** the project's charter is first approved
- **THEN** its vault exists with the listed files and folders, and `charter.md` holds the approved charter

#### Scenario: Existing project without a vault
- **WHEN** the hub starts, the charter is approved and there is no vault folder
- **THEN** the vault is created with the latest charter and any already-starred papers are queued for ingest

### Requirement: Evidence note per starred paper
Ingesting a starred paper SHALL create exactly one note in `sources/` named `{first-author-lastname}-{year}-{first-5-title-words}` with properties (title, identifiers, year, venue, level, kind, scores, date added, the user's reason) and the sections Summary, Contributions, Method, Results, Limitations, Open questions, Related papers.

#### Scenario: Note created
- **WHEN** a starred paper is ingested
- **THEN** one note with that name, all listed properties and all seven sections exists in `sources/`

#### Scenario: Star replayed
- **WHEN** the ingest run is replayed after a crash
- **THEN** still exactly one note exists for the paper

### Requirement: Notes are grounded
A note's content SHALL come only from the paper's metadata, abstract and the user's reason (full text from v1); a section without supporting information SHALL say "Not stated in the abstract" instead of guessing.

#### Scenario: Missing results
- **WHEN** an abstract reports no results
- **THEN** the Results section reads "Not stated in the abstract"

### Requirement: Connected on ingest
A paper SHALL NOT count as ingested until its note links to at least one page in `concepts/` or `questions/`, creating that page if needed, and that page links back.

#### Scenario: First paper of a concept
- **WHEN** the first paper about protein language models is ingested
- **THEN** `concepts/protein-language-models.md` is created, the note links to it, and it links back to the note

### Requirement: Index and log
After each ingest, `index.md` SHALL list every knowledge-base paper on one line (title, one-line summary, level, the user's reason) and `log.md` SHALL get one appended entry.

#### Scenario: Index updated
- **WHEN** a third paper is ingested
- **THEN** `index.md` has three paper lines and `log.md` has a new entry for the ingest

### Requirement: User edits win
The agent SHALL NOT overwrite or delete content the user wrote in the vault; it SHALL only create new notes, create pages, and append to `## Related papers`, `index.md` and `log.md`.

#### Scenario: Edited note
- **WHEN** the user rewrote a note's Summary in Obsidian and a later ingest links a new paper to it
- **THEN** the user's Summary is unchanged and only `## Related papers` gains a line

### Requirement: Vault is the source of truth
Search indexes SHALL be derivable from the vault files alone; deleting them and rebuilding SHALL produce the same search results, and file changes SHALL be re-indexed within 10 seconds.

#### Scenario: Rebuild
- **WHEN** the search index is deleted and rebuilt
- **THEN** the same query returns the same notes in the same order

#### Scenario: External edit
- **WHEN** the user adds a sentence to a note in Obsidian
- **THEN** a search for that sentence finds the note within 10 seconds

### Requirement: Keyword search
The agent and the UI SHALL be able to search the vault by keywords and receive ranked notes with a matching excerpt.

#### Scenario: Search
- **WHEN** the vault is searched for "contact map"
- **THEN** notes mentioning it are returned ranked, each with an excerpt containing the term

### Requirement: Agent sees the index
The project agent SHALL always have `index.md` in its context and SHALL read full notes only on demand.

#### Scenario: Ask about the KB
- **WHEN** the user asks the agent which knowledge-base papers cover Q2
- **THEN** the agent answers from the index and opens notes only for the papers it cites

### Requirement: Library view
The UI SHALL list knowledge-base papers with level, date added and the user's reason, and SHALL open a note's rendered content.

#### Scenario: Open note
- **WHEN** the user clicks a paper in the Library
- **THEN** the note's sections and properties are shown, rendered from the vault file

### Requirement: Notes from the full text
The librarian SHALL receive a starred paper's full text, when the hub has it, in addition to the abstract, and its
groundedness check SHALL accept numbers found in the full text.

#### Scenario: A number from the results section
- **WHEN** the note cites "0.87 AUROC" that appears only in the full text's results section
- **THEN** the note is accepted
