import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestDatabase } from '../testing/postgres';
import { createDb, type Db } from './client';
import { resolveAppDatabaseUrl, resolveAppLogin, resolveDatabaseUrl } from './env';
import { checkDbHealth } from './health';
import { runMigrations } from './migrate';

let db: Db;

beforeAll(async () => {
  db = createDb({ connectionString: await createTestDatabase(inject('testPgAdminUrl')) });
});

afterAll(async () => {
  await db.$client.end();
});

describe('database', () => {
  it('has the required extensions (pg_trgm, unaccent, pgcrypto)', async () => {
    const { rows } = await db.$client.query<{ extname: string }>(
      'select extname from pg_extension order by extname',
    );
    expect(rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['pg_trgm', 'pgcrypto', 'unaccent']),
    );
    const { rows: probe } = await db.$client.query<{ u: string; sim: number; uuid: string }>(
      `select unaccent('Pūjā') as u, similarity('sunita', 'sunitha') as sim, gen_random_uuid()::text as uuid`,
    );
    expect(probe[0]?.u).toBe('Puja');
    expect(probe[0]?.sim).toBeGreaterThan(0.3);
  });

  it('runs on PostgreSQL 16 or newer', async () => {
    const res = await db.execute<{ v: string }>(
      sql`select current_setting('server_version_num') as v`,
    );
    expect(Number(res.rows[0]?.v)).toBeGreaterThanOrEqual(160000);
  });

  it('applies committed migrations (idempotently)', async () => {
    await runMigrations(db);
    await runMigrations(db);
    const { rows } = await db.$client.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables where table_schema = 'drizzle'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});

describe('checkDbHealth', () => {
  it('reports ok with latency for a live database', async () => {
    const health = await checkDbHealth(db);
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports not ok (without throwing) when the database is unreachable', async () => {
    const dead = createDb({ connectionString: 'postgres://x:y@127.0.0.1:1/none' });
    try {
      expect(await checkDbHealth(dead, 1_000)).toEqual({ ok: false, latencyMs: null });
    } finally {
      await dead.$client.end();
    }
  });
});

describe('resolveDatabaseUrl', () => {
  it('prefers DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a:b@h:1/d', PG_PORT: '5' })).toBe(
      'postgres://a:b@h:1/d',
    );
  });

  it('builds a URL from compose variables and escapes the password', () => {
    expect(
      resolveDatabaseUrl({ POSTGRES_USER: 'hmis', POSTGRES_PASSWORD: 'p@ss/w', PG_PORT: '55432' }),
    ).toBe('postgres://hmis:p%40ss%2Fw@127.0.0.1:55432/hmis');
  });

  it('fails clearly when nothing is configured', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/Database not configured/);
  });
});

describe('resolveAppDatabaseUrl', () => {
  const owner = { POSTGRES_USER: 'hmis', POSTGRES_PASSWORD: 'owner', PG_PORT: '55432' };

  it('swaps in the app login on the owner server', () => {
    expect(resolveAppDatabaseUrl({ ...owner, APP_DB_PASSWORD: 'p@ss/w' })).toBe(
      'postgres://hmis_app_login:p%40ss%2Fw@127.0.0.1:55432/hmis',
    );
    expect(
      resolveAppDatabaseUrl({
        DATABASE_URL: 'postgres://a:b@h:1/d',
        APP_DB_USER: 'web',
        APP_DB_PASSWORD: 'x',
      }),
    ).toBe('postgres://web:x@h:1/d');
  });

  it('prefers APP_DATABASE_URL and falls back to the owner when no login is set', () => {
    expect(resolveAppDatabaseUrl({ ...owner, APP_DATABASE_URL: 'postgres://w:x@h:2/d' })).toBe(
      'postgres://w:x@h:2/d',
    );
    expect(resolveAppDatabaseUrl({ ...owner, APP_DB_PASSWORD: '' })).toBe(
      resolveDatabaseUrl(owner),
    );
    expect(resolveAppLogin({ APP_DB_PASSWORD: '' })).toBeNull();
  });
});
