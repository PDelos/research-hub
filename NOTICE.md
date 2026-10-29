# Notice

Research Hub vendors code from **pi-durable-news-agent** by IndyDevDan:

- Source: https://github.com/disler/pi-durable-news-agent
- Commit: `273b79bb8d3d8907cae9fbd6abd3da163ee2a343` (2026-10-18)
- Vendored: `apps/shared/packages/durable-agent` → `packages/durable-agent`,
  `apps/shared/packages/jev` → `packages/jev` (renamed `@dna/*` → `@rh/*`), and the news Jev commands
  as test fixtures in `packages/jev/tests/fixtures/commands`.
- Single files adapted from it are marked with a comment naming their origin.

Local changes are tracked in this repository's history. The original license follows.

## Other software in the images (not vendored)

The add-on images include programs that run unmodified as separate processes:

- `research-hub:obsidian` and `research-hub:full`: **Ignis** 0.8.18 (AGPL-3.0), https://github.com/Nystik-gh/ignis.
  On first start the hub downloads the pinned **Obsidian** package from Obsidian's official release; it is not
  redistributed here.
- `research-hub:full`: **Docling** and **Docling Serve** (MIT), **sentence-transformers** (Apache-2.0) and **PyTorch**
  (BSD-3-Clause), installed from PyPI, with Docling's models downloaded at build time.

Fine-tuning runs on the user's own Kaggle account; the base model (`BAAI/bge-small-en-v1.5`, MIT) is downloaded
there, not distributed with the hub. Benchmark samples keep their datasets' licenses (README, "What can change").

---

MIT License

Copyright (c) 2026 IndyDevDan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
