# syntax=docker/dockerfile:1
# pg-boss worker. Bundled with esbuild, so the runtime image has no node_modules.
# Also carries the DB migrations: `docker compose run --rm worker node dist/migrate.mjs`.
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
ENV NODE_ENV=production \
    HMIS_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
