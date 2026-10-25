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
  const user = encodeURIComponent(e.POSTGRES_USER);
  const pass = encodeURIComponent(e.POSTGRES_PASSWORD);
  return `postgres://${user}:${pass}@${e.PG_HOST}:${e.PG_PORT}/${encodeURIComponent(e.POSTGRES_DB)}`;
}
