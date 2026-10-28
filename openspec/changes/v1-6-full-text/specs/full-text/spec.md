## ADDED Requirements

### Requirement: Full-text sources
The hub SHALL get a paper's full text, for each ⭐ paper before its note is written and on request for any paper, from
the first source that has it: arXiv HTML, Europe PMC JATS XML, bioRxiv/medRxiv JATS XML, then a PDF (arXiv or an
open-access link on a listed host) through the active converter; it SHALL store the sections without references,
the source, and a note for every source that failed.

#### Scenario: arXiv paper
- **WHEN** a starred paper has an arXiv id and an HTML version
- **THEN** its full text is stored with source arxiv-html and its sections in order, without the bibliography

#### Scenario: PDF only
- **WHEN** a paper has no structured version but an open-access PDF on a listed host
- **THEN** the active converter turns the PDF into sections and the source says which converter

#### Scenario: Nothing available
- **WHEN** no source has the paper
- **THEN** it is marked missing with the reason of each step, and the note is written from the abstract as before

### Requirement: Converter slot
PDF conversion SHALL be a slot with one active converter: the default in the core image needs no Python; Docling
Serve SHALL be an alternative available only in the add-on image; the slot's preset SHALL compare each converter's
output with the HTML of 10 fixed arXiv papers (word F1 and section-heading recall).

#### Scenario: Preset on the default converter
- **WHEN** the converter preset runs in the light image
- **THEN** it reports one value per paper and the mean for the PDF-text converter, at no cost

### Requirement: Full text in notes and facets
When a paper has its full text, the librarian SHALL write its note from it (trimmed to a budget) and its facet vectors
SHALL come from the sections mapped to background, method and result.

#### Scenario: Note from full text
- **WHEN** a starred paper with full text is ingested
- **THEN** the librarian's prompt contains its sections and the note may cite results found only in the full text

### Requirement: Full-text API
`GET /v1/papers/:id/fulltext` SHALL return the stored text or its absence, and `POST` SHALL fetch it now; the Library
SHALL show the source and sections with "Get full text".

#### Scenario: Get full text from the Library
- **WHEN** the user presses "Get full text" on a paper
- **THEN** the source and sections appear once fetched
