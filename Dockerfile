# Research Hub: one container per research project, serving the API and the built UI on port 4850; data lives in
# the /data volume. The default image holds only what the core needs; add-ons come as larger images (design v1-1 D2,
# v1-6 D7):
#   docker build -t research-hub .                               the light default (Library viewer, no Python)
#   docker build --target obsidian -t research-hub:obsidian .    adds the Obsidian viewer (Ignis), a preference
#   docker build --target full -t research-hub:full .            Obsidian plus Docling, the Converter slot's
#                                                                layout-aware alternative (Python, several GB)
# syntax=docker/dockerfile:1

# 0. The knowledge-base viewer for the add-on: a pinned Ignis release (AGPL-3.0, run unmodified as a separate
#    program). It contains no Obsidian code; the hub downloads the pinned Obsidian package on first start.
FROM nobbe/ignis:0.8.18 AS ignis

# 1. Build: install everything, type-check and build the UI, bundle the server into apps/rh-server/dist.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY config ./config
COPY packages/durable-agent/package.json packages/durable-agent/
COPY packages/jev/package.json packages/jev/
COPY packages/rh-sdk/package.json packages/rh-sdk/
COPY apps/rh-server/package.json apps/rh-server/
COPY apps/rh-client-browser/package.json apps/rh-client-browser/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
COPY apps ./apps
COPY vite.config.ts ./
RUN npm run build -w rh-client-browser && npm run pack -w rh-server

# 2. Runtime dependencies: only what the bundle leaves external (sqlite-vec, a native SQLite extension).
FROM node:26-slim AS deps
WORKDIR /deps
COPY package-lock.json ./
RUN node -e "const l=require('./package-lock.json');require('fs').writeFileSync('package.json',JSON.stringify({private:true,dependencies:{'sqlite-vec':l.packages['node_modules/sqlite-vec'].version}}))" \
  && npm install --omit=dev --no-audit --no-fund --no-package-lock

# 3. A minimal runtime: Debian slim with only the node binary from the build image (no npm, npx, corepack or
#    headers, which the bundled server never uses), plus libatomic, the one library node needs beyond slim Debian.
FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/sh --create-home node
COPY --from=build /usr/local/bin/node /usr/local/bin/node

# 4. The light image: the bundled server, its data files (prompts, Jev commands, plugin manifests, the vault
#    template, two helper scripts), the built UI, a non-root user and /data. The Library is the viewer.
FROM runtime AS lite
ENV NODE_ENV=production \
    RH_HOST=0.0.0.0 \
    RH_PORT=4850 \
    RH_DATA_DIR=/data \
    RH_ENV_FILE=none \
    RH_KB_VIEWER=off
WORKDIR /app
COPY package.json ./package.json
COPY --from=deps /deps/node_modules ./node_modules
COPY --from=build /app/apps/rh-server/dist ./apps/rh-server/dist
COPY apps/rh-server/plugins ./apps/rh-server/plugins
COPY apps/rh-server/prompt_engineering ./apps/rh-server/prompt_engineering
COPY apps/rh-server/vault-template ./apps/rh-server/vault-template
COPY apps/rh-server/src/kernel/plugin-runner.mjs ./apps/rh-server/src/kernel/plugin-runner.mjs
COPY apps/rh-server/src/kb/loopback.cjs ./apps/rh-server/src/kb/loopback.cjs
COPY --from=build /app/apps/rh-client-browser/dist ./apps/rh-client-browser/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4850
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4850/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/rh-server/dist/server.mjs"]

# 5. The Obsidian add-on: the light image plus Ignis, with the viewer on.
FROM lite AS obsidian
ENV RH_KB_VIEWER=on \
    RH_KB_VIEWER_DIR=/opt/ignis
COPY --from=ignis /app /opt/ignis

# 6. Everything: the Obsidian image plus Docling Serve (CPU) and sentence-transformers in a Python virtual environment
#    with Docling's models downloaded at build time; the hub starts Docling on the first PDF conversion (RH_DOCLING=on)
#    and the local embedding server for a fine-tuned embedder (RH_LOCAL_EMBED=on).
FROM obsidian AS full
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/docling \
  && /opt/docling/bin/pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu docling-serve \
  && /opt/docling/bin/pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu sentence-transformers \
  && HF_HOME=/opt/docling/hf /opt/docling/bin/docling-tools models download -o /opt/docling/models \
  && chown -R node:node /opt/docling
ENV RH_DOCLING=on \
    RH_LOCAL_EMBED=on \
    RH_LOCAL_EMBED_PYTHON=/opt/docling/bin/python \
    RH_DOCLING_CMD=/opt/docling/bin/docling-serve \
    DOCLING_SERVE_ARTIFACTS_PATH=/opt/docling/models \
    DOCLING_SERVE_MAX_SYNC_WAIT=600 \
    HF_HOME=/opt/docling/hf \
    HF_HUB_OFFLINE=1
USER node

# The default build is the light image.
FROM lite
