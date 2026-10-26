import {
  createPatientSchema,
  nameSearchKeys,
  trigramSimilarity,
  updatePatientSchema,
  type CreatePatientInput,
} from '@hmis/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, locality, patient } from '../schema';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { allocateNumber } from './number-series';
import {
  findDuplicates,
  PatientInputError,
  registerPatient,
  searchPatients,
  updatePatient,
} from './patients';
import { withTx } from './tx';

let t: PlatformTestDb;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'), 25);
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date('2026-10-26T05:00:00Z'); // 26-Oct-2026 IST
const ctx = (f: SeededFacility) => ({ db: t.app, userId: f.userId, facilityId: f.facilityId });

const form = (over: Partial<CreatePatientInput> = {}): CreatePatientInput => ({
  firstName: 'sunita',
  lastName: 'VERMA',
  sex: 'F',
  age: '28',
  mobile: '9876543210',
  ...over,
});

async function register(f: SeededFacility, over: Partial<CreatePatientInput> = {}) {
  const out = await withTx(ctx(f), (tx) =>
    registerPatient(tx, f.facilityId, createPatientSchema.parse(form(over)), NOW),
  );
  if (out.status !== 'created') throw new Error('expected created');
  return out;
}

const search = (f: SeededFacility, q: string) =>
  withTx(ctx(f), (tx) => searchPatients(tx, f.facilityId, q));

describe('registration (REG-01)', () => {
  it('title-cases the name, estimates the DOB from an age and keeps search keys in step', async () => {
    const f = await seedFacility(t.owner);
    const { id } = await register(f, { age: '25y', nameHi: 'सुनीता वर्मा' });
    const [row] = await t.app.select().from(patient).where(eq(patient.id, id));
    expect(row).toMatchObject({
      firstName: 'Sunita',
      lastName: 'Verma',
      fullName: 'Sunita Verma',
      dob: '2001-07-01',
      dobIsEstimated: true,
      searchNameNorm: 'sunita verma',
      searchNamePhonetic: nameSearchKeys('Sunita Verma').phonetic,
    });
  });

  it('stores an entered DOB as exact', async () => {
    const f = await seedFacility(t.owner);
    const { id } = await register(f, { age: undefined, dob: '1995-03-14' });
    const [row] = await t.app.select().from(patient).where(eq(patient.id, id));
    expect(row).toMatchObject({ dob: '1995-03-14', dobIsEstimated: false });
  });

  it('fills district and state from the facility, and learns a new locality once', async () => {
    const f = await seedFacility(t.owner);
    await t.owner.execute(
      sql`update facility set district = 'Sitapur', state = 'Uttar Pradesh' where id = ${f.facilityId}`,
    );
    const a = await register(f, { localityName: 'Mishrikh', mobile: '9811111111' });
    const b = await register(f, { localityName: 'mishrikh', mobile: '9822222222' });
    const rows = await t.app.select().from(patient).where(eq(patient.id, a.id));
    expect(rows[0]).toMatchObject({ district: 'Sitapur', state: 'Uttar Pradesh' });
    const locs = await t.app.select().from(locality).where(eq(locality.facilityId, f.facilityId));
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ name: 'Mishrikh', learned: true });
    const [pb] = await t.app.select().from(patient).where(eq(patient.id, b.id));
    expect(pb?.localityId).toBe(locs[0]?.id);
  });

  it('refuses a missing mobile without a reason, accepts one with a reason', () => {
    expect(createPatientSchema.safeParse(form({ mobile: undefined })).success).toBe(false);
    expect(
      createPatientSchema.safeParse(
        form({ mobile: undefined, noMobileReason: 'Village, no phone' }),
      ).success,
    ).toBe(true);
  });

  it('audits inserts and edits; name / DOB / sex edits set the changed marker', async () => {
    const f = await seedFacility(t.owner);
    const { id } = await register(f);
    const edit = (over: Partial<CreatePatientInput>) =>
      withTx(ctx(f), (tx) =>
        updatePatient(
          tx,
          f.facilityId,
          updatePatientSchema.parse({ ...form(over), id, age: undefined }),
          NOW,
        ),
      );
    expect((await edit({ occupation: 'Teacher' })).identityChanged).toBe(false);
    const [plain] = await t.app.select().from(patient).where(eq(patient.id, id));
    expect(plain?.identityChangedAt).toBeNull();
    expect((await edit({ firstName: 'Suneeta' })).identityChanged).toBe(true);
    const [changed] = await t.app.select().from(patient).where(eq(patient.id, id));
    expect(changed?.identityChangedAt).not.toBeNull();
    expect(changed?.searchNamePhonetic).toBe('sunita werma');
    const audit = await t.app
      .select({ action: auditLog.action, userId: auditLog.changedBy })
      .from(auditLog)
      .where(eq(auditLog.rowId, id));
    expect(audit.map((a) => a.action)).toEqual(['I', 'U', 'U']);
    expect(audit.every((a) => a.userId === f.userId)).toBe(true);
  });

  it('rejects edits to a cancelled patient', async () => {
    const f = await seedFacility(t.owner);
    const { id } = await register(f);
    await t.owner.execute(
      sql`update patient set status = 'cancelled', cancel_reason = 'entered twice', cancelled_at = now() where id = ${id}`,
    );
    await expect(
      withTx(ctx(f), (tx) =>
        updatePatient(tx, f.facilityId, updatePatientSchema.parse({ ...form(), id }), NOW),
      ),
    ).rejects.toBeInstanceOf(PatientInputError);
  });

  it('never stores a patient row with the app role deleting it (no hard deletes)', async () => {
    const f = await seedFacility(t.owner);
    const { id } = await register(f);
    await expect(t.app.delete(patient).where(eq(patient.id, id))).rejects.toThrow();
  });
});

describe('UHID allocation (REG-01, docs/02 §4)', () => {
  it('gives 30 concurrent registrations 30 distinct gap-free UHIDs', async () => {
    const f = await seedFacility(t.owner);
    const out = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        register(f, { firstName: `Rani${i}`, mobile: `98000${String(10000 + i)}` }),
      ),
    );
    const nums = out.map((o) => Number(o.uhid.slice(3))).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(out[0]?.uhid).toMatch(/^UH-\d{6}$/);
  });

  it('rolls the number back with a failed registration (no gap)', async () => {
    const f = await seedFacility(t.owner);
    await register(f);
    await expect(
      withTx(ctx(f), async (tx) => {
        await registerPatient(
          tx,
          f.facilityId,
          createPatientSchema.parse(form({ firstName: 'Meena', mobile: '9700000001' })),
          NOW,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const next = await register(f, { firstName: 'Geeta', mobile: '9700000002' });
    expect(next.uhid).toBe('UH-000002');
  });

  it('shares the series with other allocators and honours a configured prefix', async () => {
    const f = await seedFacility(t.owner);
    await t.owner.execute(sql`insert into setting (id, facility_id, key, value)
      values (gen_random_uuid(), ${f.facilityId}, 'numberSeries.config', '{"uhid":{"prefix":"GH"}}'::jsonb)`);
    const a = await register(f);
    const extra = await withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'uhid', NOW));
    expect(a.uhid).toBe('GH-000001');
    expect(extra.formatted).toBe('GH-000002');
    expect((await search(f, 'gh-1')).rows.map((r) => r.uhid)).toEqual(['GH-000001']);
  });
});

describe('duplicate check (REG-01, docs/10 §3)', () => {
  it('flags same mobile + similar spelling + close age, and creates nothing', async () => {
    const f = await seedFacility(t.owner);
    const first = await register(f);
    const out = await withTx(ctx(f), (tx) =>
      registerPatient(
        tx,
        f.facilityId,
        createPatientSchema.parse(form({ firstName: 'Suneeta', age: '29' })),
        NOW,
      ),
    );
    expect(out.status).toBe('duplicates');
    if (out.status !== 'duplicates') return;
    expect(out.matches.map((m) => m.id)).toEqual([first.id]);
    expect(out.matches[0]?.score).toBeGreaterThanOrEqual(0.6);
    const count = await t.app
      .select({ n: sql<number>`count(*)::int` })
      .from(patient)
      .where(eq(patient.facilityId, f.facilityId));
    expect(count[0]?.n).toBe(1);
  });

  it('does not flag different family members on the same mobile', async () => {
    const f = await seedFacility(t.owner);
    await register(f);
    const husband = await register(f, { firstName: 'Rakesh', sex: 'M', age: '31' });
    const daughter = await register(f, { firstName: 'Pooja', age: '3' });
    expect(new Set([husband.uhid, daughter.uhid]).size).toBe(2);
    const fam = await search(f, '9876543210');
    expect(fam.family).toBe(true);
    expect(fam.rows).toHaveLength(3);
  });

  it('does not flag when the age is more than 2 years apart, or the mobile differs', async () => {
    const f = await seedFacility(t.owner);
    await register(f, { age: '28' });
    const probe = (mobile: string, dob: string) =>
      withTx(ctx(f), (tx) =>
        findDuplicates(tx, f.facilityId, { firstName: 'Sunita', lastName: 'Verma', mobile, dob }),
      );
    expect(await probe('9876543210', '1998-07-01')).toHaveLength(1); // ~28y
    expect(await probe('9876543210', '1996-07-01')).toHaveLength(1); // 2y apart
    expect(await probe('9876543210', '1990-07-01')).toHaveLength(0); // 8y apart
    expect(await probe('9123456780', '1998-07-01')).toHaveLength(0); // other mobile
  });

  it('also matches the alternate mobile; ignores cancelled patients', async () => {
    const f = await seedFacility(t.owner);
    const a = await register(f, { altMobile: '9333333333' });
    const probe = () =>
      withTx(ctx(f), (tx) =>
        findDuplicates(tx, f.facilityId, {
          firstName: 'Sunita',
          lastName: 'Verma',
          mobile: '9333333333',
          dob: '1998-07-01',
        }),
      );
    expect(await probe()).toHaveLength(1);
    await t.owner.execute(
      sql`update patient set status = 'cancelled', cancel_reason = 'x', cancelled_at = now() where id = ${a.id}`,
    );
    expect(await probe()).toHaveLength(0);
  });

  it('"Create new anyway" needs a reason, stores it and creates the patient', async () => {
    const f = await seedFacility(t.owner);
    await register(f);
    expect(
      createPatientSchema.safeParse(form({ duplicateOverride: { reason: ' ' } })).success,
    ).toBe(false);
    const out = await withTx(ctx(f), (tx) =>
      registerPatient(
        tx,
        f.facilityId,
        createPatientSchema.parse(
          form({ duplicateOverride: { reason: 'Twin sister, same name initial' } }),
        ),
        NOW,
      ),
    );
    expect(out.status).toBe('created');
    if (out.status !== 'created') return;
    const [row] = await t.app.select().from(patient).where(eq(patient.id, out.id));
    expect(row?.duplicateOverrideReason).toBe('Twin sister, same name initial');
  });

  it('follows the configured threshold (stricter setting stops flagging near matches)', async () => {
    const f = await seedFacility(t.owner);
    await register(f, { firstName: 'Anita', lastName: 'Gupta' });
    const probe = () =>
      withTx(ctx(f), (tx) =>
        findDuplicates(tx, f.facilityId, {
          firstName: 'Anitha',
          lastName: 'Gupta',
          mobile: '9876543210',
          dob: '1998-07-01',
        }),
      );
    expect(await probe()).toHaveLength(1);
    await t.owner.execute(sql`insert into setting (id, facility_id, key, value)
      values (gen_random_uuid(), ${f.facilityId}, 'registration.duplicateMinSimilarityPct', '100'::jsonb)`);
    expect(await probe()).toHaveLength(1); // identical after phonetic folding
    await register(f, { firstName: 'Anjali', lastName: 'Gupta', mobile: '9555555555' });
    const near = await withTx(ctx(f), (tx) =>
      findDuplicates(tx, f.facilityId, {
        firstName: 'Anjli',
        lastName: 'Gupta',
        mobile: '9555555555',
        dob: '1998-07-01',
      }),
    );
    expect(near).toHaveLength(0);
  });

  it('computes similarity exactly like pg_trgm (shared helper parity)', async () => {
    const pairs = [
      ['sunita warma', 'suneeta warma'],
      ['rakes gupta', 'rakesh gupta'],
      ['pu nam', 'punam'],
      ['अनीता', 'anita'],
    ] as const;
    for (const [a, b] of pairs) {
      const res = await t.owner.execute<{ s: number }>(
        sql`select similarity(${a}, ${b})::float8 as s`,
      );
      expect(Number(res.rows[0]?.s)).toBeCloseTo(trigramSimilarity(a, b), 5);
    }
  });
});

describe('search (REG-02)', () => {
  let f: SeededFacility;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    f = await seedFacility(t.owner);
    const people: [string, Partial<CreatePatientInput>][] = [
      [
        'poonam',
        {
          firstName: 'Poonam',
          lastName: 'Yadav',
          mobile: '9810000001',
          guardianName: 'Ramesh Yadav',
          localityName: 'Sitapur Road',
        },
      ],
      [
        'punam',
        { firstName: 'Punam', lastName: 'Singh', mobile: '9810000002', localityName: 'Mishrikh' },
      ],
      [
        'sunita',
        { firstName: 'Sunita', lastName: 'Verma', mobile: '9810000003', localityName: 'Mishrikh' },
      ],
      [
        'suneeta',
        { firstName: 'Suneeta', lastName: 'Devi', mobile: '9810000004', guardianName: 'Mohan Lal' },
      ],
      ['sunitha', { firstName: 'Sunitha', lastName: 'Kumari', mobile: '9810000005' }],
      ['vijay', { firstName: 'Vijay', lastName: 'Kumar', sex: 'M', mobile: '9810000006' }],
      ['wijay', { firstName: 'Wijay', lastName: 'Pal', sex: 'M', mobile: '9810000007' }],
      ['shyam', { firstName: 'Shyam', lastName: 'Lal', sex: 'M', mobile: '9810000008' }],
      ['syam', { firstName: 'Syam', lastName: 'Lal', sex: 'M', mobile: '9810000009' }],
      ['mohd', { firstName: 'Meena', lastName: 'Pandey', mobile: '9810000010' }],
      ['geeta', { firstName: 'Geeta', lastName: 'Devi', mobile: '9810000011' }],
      ['rani', { firstName: 'Rani', lastName: 'Tiwari', mobile: '9810000012' }],
    ];
    for (const [key, p] of people) ids[key] = (await register(f, p)).id;
  });

  const names = async (q: string) => (await search(f, q)).rows.map((r) => r.fullName);

  it('finds Indian spelling variants of a first name', async () => {
    expect(await names('Poonam')).toEqual(expect.arrayContaining(['Poonam Yadav', 'Punam Singh']));
    expect(await names('Punam')).toEqual(expect.arrayContaining(['Poonam Yadav', 'Punam Singh']));
    const sunitas = await names('sunita');
    expect(sunitas.slice(0, 3).sort()).toEqual(
      ['Sunita Verma', 'Sunitha Kumari', 'Suneeta Devi'].sort(),
    );
    expect(await names('Vijay')).toEqual(expect.arrayContaining(['Vijay Kumar', 'Wijay Pal']));
    expect(await names('Syam lal')).toEqual(expect.arrayContaining(['Shyam Lal', 'Syam Lal']));
  });

  it('ranks the exact full name first and unrelated names not at all', async () => {
    const r = await search(f, 'Sunita Verma');
    expect(r.rows[0]?.fullName).toBe('Sunita Verma');
    const lal = await names('shyam lal');
    expect(lal.slice(0, 2).sort()).toEqual(['Shyam Lal', 'Syam Lal']);
    expect(await names('Geeta')).not.toContain('Vijay Kumar');
    expect(await names('zzzzzz')).toEqual([]);
  });

  it('tolerates typos and partial typing', async () => {
    expect(await names('Poonm')).toContain('Poonam Yadav');
    expect((await names('sunit')).length).toBeGreaterThanOrEqual(3);
    expect(await names('  SUNITA   verma ')).toContain('Sunita Verma');
  });

  it('uses a second word as a guardian or locality filter', async () => {
    const r = await names('sunita mishrikh');
    expect(r[0]).toBe('Sunita Verma'); // the Sunita who lives in Mishrikh
    const g = await names('suneeta mohan');
    expect(g[0]).toBe('Suneeta Devi'); // guardian Mohan Lal
  });

  it('finds a patient by the Hindi name', async () => {
    await t.owner.execute(
      sql`update patient set name_hi = 'सुनीता वर्मा' where id = ${ids.sunita!}`,
    );
    expect((await names('सुनीता')).slice(0, 1)).toEqual(['Sunita Verma']);
  });

  it('classifies mobile, UHID and name input', async () => {
    expect((await search(f, '9810000006')).rows.map((r) => r.fullName)).toEqual(['Vijay Kumar']);
    expect((await search(f, '+91 98100 00006')).kind).toBe('mobile');
    expect((await search(f, '981000')).kind).toBe('uhid');
    expect((await search(f, '981000')).rows).toEqual([]);
    const byNo = await search(f, '3');
    expect(byNo.kind).toBe('uhid');
    expect(byNo.rows.map((r) => r.uhid)).toEqual(['UH-000003']);
    expect((await search(f, 'uh-000003')).rows).toHaveLength(1);
    expect((await search(f, 'UH3')).rows).toHaveLength(1);
    expect((await search(f, '')).rows).toEqual([]);
  });

  it('keeps deceased patients findable but marks them', async () => {
    await t.owner.execute(
      sql`update patient set is_deceased = true, deceased_at = now() where id = ${ids.geeta!}`,
    );
    const r = await search(f, 'Geeta');
    expect(r.rows[0]).toMatchObject({ fullName: 'Geeta Devi', isDeceased: true });
  });

  it('is scoped to the facility and ignores cancelled patients', async () => {
    const other = await seedFacility(t.owner);
    expect((await search(other, 'Poonam')).rows).toEqual([]);
    await t.owner.execute(
      sql`update patient set status = 'cancelled', cancel_reason = 'x', cancelled_at = now() where id = ${ids.rani!}`,
    );
    expect(await names('Rani')).toEqual([]);
  });

  it('returns at most 20 rows', async () => {
    const big = await seedFacility(t.owner);
    for (let i = 0; i < 25; i++) {
      await register(big, {
        firstName: 'Kiran',
        lastName: `Sharma${i}`,
        mobile: `97${String(10000000 + i)}`,
      });
    }
    expect((await search(big, 'Kiran')).rows).toHaveLength(20);
  });
});
