# HMIS (working name)

Hospital Management Information System for small and mid-sized private hospitals in India.
It runs on a local server at the hospital; the internet is optional.

Start with [`AGENTS.md`](AGENTS.md) (rules, stack, layout) and [`docs/`](docs/). The build plan is in
[`docs/50-build-plan.md`](docs/50-build-plan.md).

## Prerequisites

- Node.js 24 LTS (version pinned in `.nvmrc`; `nvm use` picks it up)
- pnpm through Corepack: `corepack enable` (version pinned in `package.json` → `packageManager`)
- Docker with the Compose plugin (dev database, integration tests, full stack)

## Dev setup

```bash
corepack enable
pnpm install
cp .env.example .env      # edit ports / password if needed; never commit .env
pnpm dev                  # Postgres (compose) + migrations + web + worker, with hot reload
```

- Web: `http://localhost:$WEB_PORT` (default 3000). Health: `http://localhost:$WEB_PORT/api/health`.
- Postgres for local tools: `127.0.0.1:$PG_PORT` (default 55432).
- `pnpm dev:down` stops the dev Postgres (the data volume is kept).

### Several stacks on one host

Every host port comes from `.env`. Give each checkout its own `COMPOSE_PROJECT_NAME`, `WEB_PORT`,
`PG_PORT`, `CADDY_HTTPS_PORT` and `CADDY_HTTP_PORT`. Tests and E2E never use fixed ports.

## Commands

| Command                 | What it does                                                             |
| ----------------------- | ------------------------------------------------------------------------ |
| `pnpm dev`              | Dev Postgres + migrations, then web and worker in watch mode             |
| `pnpm build`            | Production builds (Next.js standalone, bundled worker)                   |
| `pnpm db:generate`      | Generate an SQL migration from the Drizzle schema (`packages/db/schema`) |
| `pnpm db:migrate`       | Apply committed migrations                                               |
| `pnpm db:seed [--demo]` | Seed master data (`--demo`: synthetic patients/OPD); filled in by FND-07 |
| `pnpm test`             | Vitest: unit + integration (starts its own Postgres with Testcontainers) |
| `pnpm e2e`              | Builds, then runs the Playwright tests against the standalone server     |
| `pnpm lint`             | ESLint + Prettier check                                                  |
| `pnpm typecheck`        | `tsc` in every package                                                   |
| `pnpm check:forbidden`  | PCPNDT forbidden-term scan (see below); runs in CI                       |

Notes:

- `pnpm test` needs a working Docker daemon. To use an existing server instead, set
  `HMIS_TEST_DATABASE_URL` to a superuser URL; each test file creates its own database.
- `pnpm e2e` needs Chromium: `pnpm --filter @hmis/web exec playwright install --with-deps chromium`.
- Migrations are additive only and are reviewed by a human (`AGENTS.md` rule 14).

## Full stack (Docker Compose)

```bash
docker compose --env-file .env -f infra/docker/docker-compose.yml up -d --build
docker compose --env-file .env -f infra/docker/docker-compose.yml run --rm worker node dist/migrate.mjs
```

Services: `caddy` (HTTPS with an internal CA on `$CADDY_HTTPS_PORT`), `web`, `worker`, `postgres`
(extensions `pg_trgm`, `unaccent`, `pgcrypto` from `infra/docker/postgres/initdb`; not published
outside the compose network) and `backup` (placeholder until OPS-01). The web container is also
published on `127.0.0.1:$WEB_PORT` for local health checks.

## Forbidden-term check (PCPNDT)

Fetal sex is never stored, displayed, inferred or printed (`AGENTS.md` rule 7). `pnpm check:forbidden`
implements `docs/30-compliance.md` §1:

- **USG / Form F scope** (every term, incl. Hindi words): `packages/print/**/usg*`,
  `packages/shared/**/usg*`, `packages/db/schema/usg*`, `packages/db/seed/**/usg*`,
  `packages/shared/forms/form-f*`, and AI prompt files (`**/prompts/**`, `**/*.prompt.*`).
- **i18n files** (`**/messages/*.json` …): keys under `usg*`, `formF*`, `pcpndt*`, `ai*` get every
  term; other keys get the unambiguous fetus-related terms.
- **Everything else** under `apps/`, `packages/`, `infra/`, `.github/`: unambiguous terms only.
- Identifiers are split before matching (`camelCase`, `snake_case`, `kebab-case`), and file paths are
  checked too.
- Allow-list: `docs/30-compliance.md`, the term list itself
  (`packages/shared/src/compliance/forbidden-terms.ts`) and the Form F key `living_children[].sex`.

The same module exports `findForbiddenTerms()` for runtime guards (USG template editor, AI output).
