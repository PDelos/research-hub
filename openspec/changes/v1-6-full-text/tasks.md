## 1. Full text

- [x] 1.1 Parsers: arXiv HTML, JATS, Docling markdown, PDF text (headings, headers, hyphenation, references); verify with fixtures
- [x] 1.2 `rh.fulltext`: sources in order, open-access host list, storage, ensure/refetch, extension point; verify with a fake fetch
- [x] 1.3 Converters: `rh.converter-pdf` (unpdf) and `rh.converter-docling` (supervised docling-serve, off unless RH_DOCLING=on); verify with a fixture PDF and a fake Docling server

## 2. Uses

- [x] 2.1 Ingest with full text (prompt, number check) and facet vectors from sections; verify offline
- [x] 2.2 Converter preset in the harness and the slot catalog; converter focus in the weekly upgrade (upgrade-focus v2); verify with cached fixture samples

## 3. API, UI, images

- [x] 3.1 Routes, SDK, Library full-text view; verify API and Playwright tests
- [ ] 3.2 Dockerfile `full` target; verify the light image is unchanged in content and the full image converts a PDF

## 4. Integration

- [ ] 4.1 All tests, checks, audit, offline e2e, bundle and light image; live: full text for real papers (HTML, JATS, PDF) and the preset on both converters
- [ ] 4.2 Docs; archive
