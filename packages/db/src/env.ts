import { z } from 'zod';

const pgEnvSchema = z.object({
  DATABASE_URL: z.url().optional(),
  POSTGRES_USER: z.string().min(1).default('hmis'),
  POSTGRES_PASSWORD: z.string().min(1).optional(),
  POSTGRES_DB: z.string().min(1).default('hmis'),
  PG_HOST: z.string().min(1).default('127.0.0.1'),
  PG_PORT: z.coerce.number().int().min(1).max(65535).optional(),
});

/**
 * Resolves the Postgres connection string.
 * `DATABASE_URL` wins (containers, CI, tests). Otherwise it is built from the same variables the
 * dev compose stack uses (`POSTGRES_*`, `PG_PORT`), so one `.env` drives both.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const e = pgEnvSchema.parse(env);
  if (e.DATABASE_URL) return e.DATABASE_URL;
  if (!e.POSTGRES_PASSWORD || !e.PG_PORT) {
    throw new Error(
      'Database not configured: set DATABASE_URL, or POSTGRES_PASSWORD and PG_PORT (see .env.example).',
    );
  }
  return buildUrl(e.POSTGRES_USER, e.POSTGRES_PASSWORD, e.PG_HOST, e.PG_PORT, e.POSTGRES_DB);
}

function buildUrl(user: string, password: string, host: string, port: number, db: string): string {
  const u = encodeURIComponent(user);
  const p = encodeURIComponent(password);
  return `postgres://${u}:${p}@${host}:${port}/${encodeURIComponent(db)}`;
}

const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const appEnvSchema = z.object({
  APP_DATABASE_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
  APP_DB_USER: z.preprocess(emptyAsUndefined, z.string().min(1).default('hmis_app_login')),
  APP_DB_PASSWORD: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
});

/** App LOGIN role credentials, or null when not configured (migrate-cli provisions them). */
export function resolveAppLogin(
  env: NodeJS.ProcessEnv = process.env,
): { user: string; password: string } | null {
  const a = appEnvSchema.parse(env);
  return a.APP_DB_PASSWORD ? { user: a.APP_DB_USER, password: a.APP_DB_PASSWORD } : null;
}

/**
 * Connection string for web/worker business queries: the least-privileged app role
 * (member of `hmis_app`, no DELETE, append-only logs; packages/db/README.md).
 * `APP_DATABASE_URL` wins; else `APP_DB_USER`/`APP_DB_PASSWORD` on the same server as
 * `resolveDatabaseUrl()`. Falls back to the owner URL when no app login is configured (fresh dev
 * checkouts), which `install.sh` (OPS-01) must never leave in production.
 */
export function resolveAppDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const a = appEnvSchema.parse(env);
  if (a.APP_DATABASE_URL) return a.APP_DATABASE_URL;
  const owner = resolveDatabaseUrl(env);
  const login = resolveAppLogin(env);
  if (!login) return owner;
  const url = new URL(owner);
  url.username = encodeURIComponent(login.user);
  url.password = encodeURIComponent(login.password);
  return url.toString();
}
