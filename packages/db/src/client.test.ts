import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestDatabase } from '../testing/postgres';
import { createDb, type Db } from './client';

let url: string;
let db: Db;

beforeAll(async () => {
  url = await createTestDatabase(inject('testPgAdminUrl'));
  db = createDb({ connectionString: url, applicationName: 'hmis-pool-test' });
});

afterAll(async () => {
  await db.$client.end();
});

describe('createPool', () => {
  it('survives pg_terminate_backend of idle pooled clients and reconnects', async () => {
    await db.execute(sql`select 1`); // park an idle client in the pool
    const killer = createDb({ connectionString: url, applicationName: 'hmis-pool-killer' });
    try {
      await killer.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'hmis-pool-test'`,
      );
    } finally {
      await killer.$client.end();
    }
    await new Promise((r) => setTimeout(r, 500));
    const res = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    expect(res.rows[0]?.ok).toBe(1);
  });
});
