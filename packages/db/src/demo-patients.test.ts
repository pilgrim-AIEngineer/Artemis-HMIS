import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createRng } from '../seed/demo/rng';
import { DEMO_SEED } from '../seed/demo';
import { demoPatients } from '../seed/demo/patients';
import type { MasterSeedResult } from '../seed/masters';
import { seedFacility, setupPlatformDb, type PlatformTestDb } from '../testing/platform';
import { searchPatients } from './patients';
import { withTx } from './tx';

let t: PlatformTestDb;
beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'), 5);
});
afterAll(async () => {
  await t.close();
});

describe('db:seed --demo patients (docs/02 §9)', () => {
  it('creates 500 synthetic patients in mobile-sharing families, once', async () => {
    const f = await seedFacility(t.owner);
    const run = () =>
      withTx({ db: t.app, userId: f.userId, facilityId: f.facilityId }, (tx) =>
        demoPatients.run({
          tx,
          facilityId: f.facilityId,
          masters: {} as MasterSeedResult,
          rng: createRng(DEMO_SEED),
        }),
      );
    expect(await run()).toMatch(/^500 added/);
    expect(await run()).toBe('500 already present');

    const stats = await t.owner.execute<{
      n: number;
      uhids: number;
      families: number;
      bad: number;
    }>(sql`
      select count(*)::int n, count(distinct uhid)::int uhids,
             (select count(*)::int from (select mobile from patient where facility_id = ${f.facilityId}
                group by mobile having count(*) > 1) x) families,
             count(*) filter (where mobile !~ '^9[0-9]{9}$' or name_hi is null or search_name_norm = '')::int bad
      from patient where facility_id = ${f.facilityId}`);
    expect(stats.rows[0]).toMatchObject({ n: 500, uhids: 500, bad: 0 });
    expect(stats.rows[0]!.families).toBeGreaterThan(100);

    const sample = await t.owner.execute<{ mobile: string; full_name: string }>(
      sql`select mobile, full_name from patient where facility_id = ${f.facilityId} order by uhid limit 1`,
    );
    const hit = await withTx({ db: t.app, userId: f.userId }, (tx) =>
      searchPatients(tx, f.facilityId, sample.rows[0]!.full_name),
    );
    expect(hit.rows[0]?.fullName).toBe(sample.rows[0]!.full_name);
  });
});
