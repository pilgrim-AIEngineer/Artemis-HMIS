import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { searchPatients } from '../src/patients';
import { withTx } from '../src/tx';

/**
 * Wall-clock search budget (docs/10 §2). Kept apart from patients.test.ts and run on its own
 * (vitest.perf.config.ts, after the parallel projects) so the 300 ms limit measures the query,
 * not the other test files competing for the CPU.
 */
let t: PlatformTestDb;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'), 25);
});
afterAll(async () => {
  await t.close();
});

const ctx = (f: SeededFacility) => ({ db: t.app, userId: f.userId, facilityId: f.facilityId });

const search = (f: SeededFacility, q: string) =>
  withTx(ctx(f), (tx) => searchPatients(tx, f.facilityId, q));

describe('search speed with 2 lakh patients (docs/10 §2)', () => {
  it('answers name, mobile and UHID searches under 300 ms', async () => {
    const f = await seedFacility(t.owner);
    // Pseudo-names from syllables (a realistic spread of ~60k distinct first names and surnames),
    // plus 1% "Sunita <surname>" so a common first name has thousands of candidates.
    await t.owner.execute(sql`
      with syl(a) as (select unnest(array['su','ni','ta','po','nam','re','kha','me','na','ka','vi','ta','sa','pu','ja','ne','ha','pri','ya','gee','raj','esh','ram','dev','an','il','jay','sanj','man','oj','din','rak','aj','mu','kes','pra','deep','am','it','rah'])),
           ns as (select array_agg(a) as s from syl),
           gen as (
             select g,
               case when g % 100 = 0 then 'sunita'
                    else (ns.s)[1 + g % 40] || (ns.s)[1 + (g / 40) % 40] || (ns.s)[1 + (g / 1600) % 40] end as f,
               (ns.s)[1 + (g * 7) % 40] || (ns.s)[1 + (g / 13) % 40] || (ns.s)[1 + (g / 211) % 40] as l
             from generate_series(1, 200000) g, ns)
      insert into patient (id, facility_id, uhid, first_name, last_name, sex, dob, mobile, search_name_norm, search_name_phonetic)
      select gen_random_uuid(), ${f.facilityId}, 'UH-' || lpad((g + 1000)::text, 6, '0'), initcap(f), initcap(l), 'F', date '1990-01-01',
             '9' || lpad(g::text, 9, '0'), f || ' ' || l, f || ' ' || l from gen`);
    const [probe] = (
      await t.owner.execute<{ n: string }>(
        sql`select search_name_norm as n from patient where facility_id = ${f.facilityId} and mobile = '9000150001'`,
      )
    ).rows;
    await t.owner.execute(sql`analyze patient`);
    const time = async (q: string) => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const s = performance.now();
        await search(f, q);
        runs.push(performance.now() - s);
      }
      return Math.min(...runs);
    };
    expect(await time(probe!.n)).toBeLessThan(300); // a specific full name
    expect(await time('sunita')).toBeLessThan(300); // common first name, thousands of rows
    expect(await time('sunita ' + probe!.n.split(' ')[1])).toBeLessThan(300);
    expect(await time(probe!.n.slice(0, -1))).toBeLessThan(300); // typo / partial
    expect(await time('9000150000')).toBeLessThan(300);
    expect(await time('UH-050000')).toBeLessThan(300);
  }, 120_000);
});
