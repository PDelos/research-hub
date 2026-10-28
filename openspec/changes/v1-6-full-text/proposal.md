## Why

EVOLUTION.md §6 step 7: notes and representations come from abstracts only, which miss methods, results and open
questions. Starred papers deserve their full text. Most papers in the field have a structured version (arXiv HTML,
Europe PMC and bioRxiv JATS XML) that needs no conversion; PDF-only papers need a converter, which is a slot: a light
Node converter in the core image, Docling as a better alternative in an add-on image (decision 2026-10-28: the core
image holds only what the core needs, no Python).

## What Changes

- **Full text** (new core plugin `rh.fulltext`): for a ⭐ paper (before the librarian writes its note) and on request
  for any paper, the text is taken from the first source that has it: arXiv HTML (LaTeXML), Europe PMC JATS XML (open
  access, by PMCID), bioRxiv/medRxiv JATS XML (by DOI), then a PDF (arXiv, or the paper's open-access link on a listed
  open-access host) through the active **converter**. Stored as sections (title, text) without references, with its
  source; failures are recorded with the reason.
- **Converter slot** (extension point `fulltext.converter`, one active): `rh.converter-pdf` (default, core image:
  `unpdf`, line-based headings, de-hyphenation, running headers and references removed) and `rh.converter-docling`
  (add-on image `research-hub:full`: Docling Serve run as a supervised local process, off unless `RH_DOCLING=on`).
- **The converter preset**: 10 fixed arXiv papers that have both a PDF and an HTML version; the HTML is the ground
  truth; metric: the mean of word F1 and section-heading recall. Run from the Plugins tab like the other presets.
- **The weekly upgrade** gains a `converter` focus: when an alternative converter is available, both run the preset
  and a better one (by 0.02) is proposed; approving switches the slot.
- **Uses of the full text**: the librarian writes the KB note from it (sections trimmed to a budget; the groundedness
  check includes it), and the paper's facet vectors (background, method, result) come from its sections (mapped by
  heading) instead of abstract sentences.
- **API and UI**: `GET/POST /v1/papers/:id/fulltext`; the Library shows a paper's full-text source and sections, with
  "Get full text".
- **Images**: the light image stays without Python; a new `full` target adds Python and Docling Serve.

## Out of scope

Full text for every gathered paper (only ⭐ and on request), figures and tables as data, OCR of scanned PDFs in the
light image, chunk-level search over full text (the KB search indexes notes).

## Capabilities

### New Capabilities
- `full-text`: sources, the converter slot, storage, uses, API.

### Modified Capabilities
- `slots`: the Converter slot and its preset.
- `knowledge-vault`: notes written from the full text when there is one.

## Impact

New built-ins `rh.fulltext`, `rh.converter-pdf`, `rh.converter-docling`; `src/fulltext/*`; harness (converter preset);
`rh.upgrades` (focus `converter`, `upgrade-focus` v2); `src/kb/ingest.ts`, `src/representations/vectors.ts`;
Library tab; Dockerfile `full` target; dependencies `unpdf`, `node-html-parser`.
