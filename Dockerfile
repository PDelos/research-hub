# Research Hub: one container serving the API, the built UI and the knowledge-base viewer (Ignis, a supervised
# child process on loopback, reached through the hub at /kb/) on port 4850. Data lives in the /data volume.
# syntax=docker/dockerfile:1

# 0. The knowledge-base viewer: a pinned Ignis release (AGPL-3.0, run unmodified as a separate program). It contains
#    no Obsidian code; the hub downloads the pinned Obsidian package from Obsidian's official release on first start.
FROM nobbe/ignis:0.8.18 AS ignis

# 1. Build: install everything, type-check and build the UI.
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
RUN npm run build -w rh-client-browser

# 2. Production dependencies only.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/durable-agent/package.json packages/durable-agent/
COPY packages/jev/package.json packages/jev/
COPY packages/rh-sdk/package.json packages/rh-sdk/
COPY apps/rh-server/package.json apps/rh-server/
COPY apps/rh-client-browser/package.json apps/rh-client-browser/
RUN npm ci --omit=dev --no-audit --no-fund

# 3. Runtime: sources run with tsx, the built UI, a non-root user, and /data.
FROM node:26-slim
ENV NODE_ENV=production \
    RH_HOST=0.0.0.0 \
    RH_PORT=4850 \
    RH_DATA_DIR=/data \
    RH_ENV_FILE=none \
    RH_KB_VIEWER_DIR=/opt/ignis
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY config ./config
COPY packages ./packages
COPY apps/rh-server ./apps/rh-server
COPY --from=build /app/apps/rh-client-browser/dist ./apps/rh-client-browser/dist
COPY --from=build /app/apps/rh-client-browser/package.json ./apps/rh-client-browser/package.json
COPY --from=ignis /app /opt/ignis
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4850
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4850/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--import", "tsx", "apps/rh-server/src/main.ts"]
