## Decisions

### D1. Ideas and stages
Table `p_rh_engineer__ideas`: source (suggestion / user / slot), text, stage (researching, assessed, building, built,
proposed, installed, rejected, failed, not-buildable), assessment JSON, kind, plugin id, log JSON (timestamped lines),
numbers JSON, timestamps. One idea is worked on at a time; stages run in the background.

### D2. Research and assessment
`research(prompt)` (web) about the idea, then one review-model call returning JSON: `{ worth: boolean, kind:
"paper-source" | "embedder-finetune" | "other", gain, cost, risk, plan, api: { baseUrl, docsUrl } }`. Kinds the
engineer cannot build are recorded as not-buildable with the assessment.

### D3. Paper-source builder
The model gets the plan, the API notes and a fixed template (the `sources` export shape, `rh.http.json/text`, the
normalized paper fields) and returns JSON `{ manifest, main }`. The hub fixes the manifest's id (`eng.<slug>`), kind
addon, topic finding, the contribution and the network permission (the API host only), writes both files to
`data/engineer/<idea>/plugin`, and installs through the installer (actor `proposal:engineer-<id>`). Contract test:
activate, `search({ query: <first charter query>, limit: 5 })` within 60 s, at least one result with a title and an
identifier or URL. On failure the error goes back to the model (3 attempts), then the plugin is uninstalled. On
success it is disabled and an Enable proposal is made.

### D4. Kaggle runner
`https://api.kaggle.com/v1/kernels.KernelsApiService/{SaveKernel,GetKernelSessionStatus,ListKernelSessionOutput}`
with `Authorization: Bearer <KAGGLE_API_TOKEN>` (or HTTP Basic with `KAGGLE_USERNAME`/`KAGGLE_KEY`). SaveKernel: slug
`<user>/rh-<project>-<idea>`, `language: python`, `kernelType: script`, private, GPU and internet on. Status polled
every 60 s until COMPLETE or ERROR (at most 6 hours). Output: every file under `model/` downloaded to
`data/engineer/models/<idea>/`.

### D5. Fine-tuning script and data
Pairs (charter question text, liked paper title + abstract) and hard negatives (disliked papers), at most 2,000, inlined
as base64 JSON. The script installs sentence-transformers, fine-tunes `BAAI/bge-small-en-v1.5` (small, open) with
MultipleNegativesRankingLoss for 2 epochs, and saves the model to `/kaggle/working/model`.

### D6. Local embedder
`rh.embedder-local` (slot embedder, contribution `local`): settings `model` (a path under the data folder) and `dims`
(learned from the first embedding). With `RH_LOCAL_EMBED=on` it starts `python3 embed-server.py` (in the full image:
sentence-transformers, `POST /embed {texts} → {vectors}`), else it uses `RH_LOCAL_EMBED_URL`; otherwise unavailable.
The harness's embedder preset accepts `{ provider: "local", model }`. `rh.papers` re-resolves the active embedder
plugin when its `papers.embedder` setting changes and emits `embedder.changed`.

### D7. UI
Upgrades tab: an Engineer section with a text box ("Propose an idea"), each idea's stage and assessment, Build / Reject
after assessment, the log, Enable / Remove for a built plugin; suggestions get "Ask the engineer".
