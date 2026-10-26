/**
 * Test-only Postgres harness. Starts a throwaway container via Testcontainers (random host port,
 * cleaned up by Ryuk), with the same init script as production compose, so `pnpm test` needs no
 * manual setup. Set `HMIS_TEST_DATABASE_URL` to reuse an existing server instead.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

/** Keep in step with `PG_IMAGE` default in infra/docker/docker-compose.yml. */
export const DEFAULT_PG_IMAGE = 'postgres:17';

const INIT_SQL = fileURLToPath(
  new URL('../../../infra/docker/postgres/initdb/01-extensions.sql', import.meta.url),
);

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the per-run test server (create per-file DBs with `createTestDatabase`). */
    testPgAdminUrl: string;
  }
}

/**
 * Starts a throwaway Postgres (random host port, removed by Ryuk when the process exits) with
 * the production init script. Returns the superuser URL. Used by Vitest and the E2E server.
 */
export async function startPostgresContainer(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(
    process.env.HMIS_TEST_PG_IMAGE ?? DEFAULT_PG_IMAGE,
  )
    .withDatabase('hmis_test')
    .withUsername('hmis')
    .withPassword(randomBytes(12).toString('hex'))
    // Every test file opens its own pools (up to ~35 connections) and Vitest runs files in
    // parallel: the default of 100 runs out as the suite grows ("too many clients").
    .withCommand(['postgres', '-c', 'max_connections=600'])
    .withCopyFilesToContainer([
      { source: INIT_SQL, target: '/docker-entrypoint-initdb.d/01-extensions.sql' },
    ])
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Vitest `globalSetup` entry: one container per test project run. */
export async function setupTestPostgres(project: TestProject) {
  const external = process.env.HMIS_TEST_DATABASE_URL;
  if (external) {
    project.provide('testPgAdminUrl', external);
    return;
  }
  const pg = await startPostgresContainer();
  project.provide('testPgAdminUrl', pg.url);
  return pg.stop;
}

/** Creates an isolated database (inherits extensions from template1) and returns its URL. */
export async function createTestDatabase(adminUrl: string): Promise<string> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`create database ${name} template template1`);
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
