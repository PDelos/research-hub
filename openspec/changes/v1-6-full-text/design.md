## Decisions

### D1. Sources in order
1. arXiv HTML `https://arxiv.org/html/<id>` (id from `paper_ids`): top-level `section.ltx_section` with its `h2`
   title; text from `p.ltx_p` (math replaced by its `alttext`); abstract from `.ltx_abstract`; bibliography and
   appendices dropped.
2. Europe PMC `https://www.ebi.ac.uk/europepmc/webservices/rest/<PMCID>/fullTextXML`: JATS `body > sec` with
   `title` and `p` (nested `sec` flattened into their parent).
3. bioRxiv/medRxiv for a `10.1101/` DOI: `https://api.biorxiv.org/details/<server>/<doi>` → the latest version's
   `jatsxml` URL → JATS as above.
4. PDF: `https://arxiv.org/pdf/<id>`, else `oa_url` when its host is on the open-access list (arXiv, bioRxiv,
   medRxiv, Europe PMC, PMC, PLOS, BioMed Central, Frontiers, MDPI, Nature, eLife, OUP, OpenReview, PMLR, NeurIPS,
   ACL Anthology, CVF), through the active converter.
Each step's failure is recorded and the next is tried; the result keeps `source` (arxiv-html, europepmc-jats,
biorxiv-jats, pdf:<converter>) and per-step notes.

### D2. Storage
`p_rh_fulltext__texts` (paper_id primary key, status ok / missing, source, sections JSON, chars, notes JSON,
fetched_at). Sections are at most 60, each text at most 20,000 characters. `ensure(paperId)` returns the stored text
or fetches it (one fetch per paper at a time); `refetch` on request.

### D3. Converter slot
Extension point `fulltext.converter` offered by `rh.fulltext` (cardinality one, default `pdf-text`; setting
`fulltext.converter`). A converter exports `convert(pdf: Uint8Array): Promise<{ sections }>` and `available()`.
`rh.converter-pdf`: `unpdf` text per page; lines repeated on 3+ pages removed (running headers); "word-\nword" joined;
headings: numbered (`2`, `2.1`, `II.`) or known names (Abstract, Introduction, Background, Related work, Methods,
Materials and methods, Results, Experiments, Discussion, Conclusion), at most 90 characters; text after
References/Bibliography dropped. `rh.converter-docling`: when `RH_DOCLING=on`, starts `docling-serve run --host
127.0.0.1 --port <RH_DOCLING_PORT, 5001>` as a supervised child process (restart with backoff), converts through
`POST /v1/convert/file` (`files`, `to_formats=md`) and splits `document.md_content` at `#`/`##` headings.

### D4. The converter preset
`converter-arxiv`: 10 fixed arXiv q-bio.BM papers (ids with versions in `src/harness/benchmarks/converter.ts`), PDF
and HTML downloaded once and cached in rh.harness storage. Per paper: word F1 between the converter's text and the
HTML's (lowercased words of 3+ letters, multiset), and heading recall (HTML section titles found, normalized, among
the converter's headings); value = mean over papers of (F1 + recall) / 2. Free (no paid calls).

### D5. Uses
Ingest: before the librarian starts, `fulltext.ensure` (at most 90 s); the prompt's FULL_TEXT block holds the
sections, trimmed to 24,000 characters in total (each section's head kept); the system prompt allows the full text as
a source; the number check includes it. Facets: `PaperVectors` takes an optional `fullTextFacets(paperId)`; section
titles map to background (introduction, background, related work, motivation), method (method(s), approach, model,
materials, experimental setup, data) and result (results, experiments, evaluation, discussion, conclusion); each
facet's text (at most 6,000 characters) replaces the abstract sentences; after a fetch the paper's vectors are
recomputed.

### D6. Weekly upgrade
Focus `converter` (Jev `upgrade-focus` version 2 adds it): skipped with a note when only one converter is available;
otherwise the preset runs on each, and the best one beating the active by 0.02 is proposed (kind `converter`);
approving sets `rh.fulltext`'s `fulltext.converter`.

### D7. Images
Dockerfile target `full` (from `lite`): Python 3 venv with `docling-serve` (CPU torch) and Docling's models
downloaded at build time, `RH_DOCLING=on`. The light image is unchanged.
