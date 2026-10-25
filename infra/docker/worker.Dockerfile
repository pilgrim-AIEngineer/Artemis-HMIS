# syntax=docker/dockerfile:1
# pg-boss worker. Bundled with esbuild; the runtime image only adds playwright-core (for pdf.render)
# and headless Chromium. Also carries the DB migrations:
# `docker compose run --rm worker node dist/migrate.mjs`.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm turbo run build --filter=@hmis/worker

FROM ${NODE_IMAGE} AS runtime
# Must equal "playwright-core" in apps/worker/package.json (pdf-render.test.ts checks it).
ARG PLAYWRIGHT_VERSION=1.64.1
ENV NODE_ENV=production \
    HMIS_MIGRATIONS_DIR=/app/migrations \
    HMIS_FONT_DIR=/app/fonts \
    HMIS_FILES_DIR=/data/files \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HMIS_CHROMIUM_NO_SANDBOX=1
WORKDIR /app
# Headless Chromium + its system libraries for the pdf.render job (docs/01 §2). The driver stays
# outside the esbuild bundle (it finds its own files at run time); the browser lives in
# /ms-playwright, readable by the unprivileged user below.
RUN npm install --no-save --no-audit --no-fund --prefix /app playwright-core@${PLAYWRIGHT_VERSION} \
    && node /app/node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir -p /data/files && chown node:node /data/files
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
# Bundled Noto Sans + Devanagari (no CDN): inlined into the PDF pages by @hmis/print/node.
COPY --from=build --chown=node:node /repo/packages/print/fonts ./fonts
VOLUME ["/data/files"]
USER node
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
