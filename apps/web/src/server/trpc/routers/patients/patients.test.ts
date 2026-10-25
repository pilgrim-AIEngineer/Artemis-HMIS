import { withTx } from '@hmis/db';
import { insertUser } from '@hmis/db/auth';
import { auditLog, patient } from '@hmis/db/schema';
import type { CreatePatientInput } from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PASSWORD,
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let reception: TestBrowser;
let nurse: TestBrowser;
let admin: TestBrowser;
let noRoles: TestBrowser;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  const login = async (username: string) => {
    const b = f.browser();
    await b.login(username);
    return b;
  };
  reception = await login(f.users.reception.username);
  nurse = await login(f.users.nurse.username);
  admin = await login(f.users.admin.username);
  noRoles = await login(f.users.noRoles.username);
});

afterAll(async () => {
  await f.close();
});

const form = (over: Partial<CreatePatientInput> = {}): CreatePatientInput => ({
  firstName: 'anita',
  lastName: 'gupta',
  sex: 'F',
  age: '30',
  mobile: '9415000001',
  ...over,
});

describe('patients access (AGENTS.md rule 6)', () => {
  it('lets reception create, edit, search and read', async () => {
    const out = await reception.call((c) => c.patients.create(form()));
    expect(out.status).toBe('created');
    if (out.status !== 'created') return;
    expect(out.uhid).toBe('UH-000001');
    const got = await reception.call((c) => c.patients.get({ id: out.id }));
    expect(got).toMatchObject({ fullName: 'Anita Gupta', sex: 'F', dobIsEstimated: true });
    const found = await reception.call((c) => c.patients.search({ q: 'anita' }));
    expect(found.rows.map((r) => r.id)).toContain(out.id);
    const upd = await reception.call((c) =>
      c.patients.update({ ...form({ occupation: 'Teacher' }), id: out.id, age: undefined }),
    );
    expect(upd.identityChanged).toBe(false);
  });

  it('lets the nurse look up patients but not register or edit', async () => {
    expect(
      (await nurse.call((c) => c.patients.search({ q: 'anita' }))).rows.length,
    ).toBeGreaterThan(0);
    for (const call of [
      () => nurse.call((c) => c.patients.create(form({ mobile: '9415000002' }))),
      () =>
        nurse.call((c) =>
          c.patients.checkDuplicates({ firstName: 'a', mobile: '9415000001', age: '3' }),
        ),
      () => nurse.call((c) => c.patients.defaults()),
    ]) {
      expect((await trpcError(call())).code).toBe('FORBIDDEN');
    }
    const [row] = await f.db.select().from(patient).limit(1);
    expect(
      (
        await trpcError(
          nurse.call((c) => c.patients.update({ ...form(), id: row!.id, age: undefined })),
        )
      ).code,
    ).toBe('FORBIDDEN');
  });

  it('refuses admin registration (no clinical/front-desk edit) and users without roles', async () => {
    expect((await trpcError(admin.call((c) => c.patients.create(form())))).code).toBe('FORBIDDEN');
    expect((await trpcError(noRoles.call((c) => c.patients.search({ q: 'anita' })))).code).toBe(
      'FORBIDDEN',
    );
    expect((await trpcError(f.browser().call((c) => c.patients.search({ q: 'anita' })))).code).toBe(
      'UNAUTHORIZED',
    );
  });

  it('keeps hospitals apart', async () => {
    const [row] = await f.db.select().from(patient).limit(1);
    const receptionB = f.browser();
    const username = `reception_b_${Date.now().toString(36)}`;
    await withTx({ db: f.db, userId: null }, (tx) =>
      insertUser(tx, {
        facilityId: f.b.facilityId,
        username,
        fullName: 'Reception B',
        password: PASSWORD,
        roles: ['reception'],
      }),
    );
    await receptionB.login(username);
    const other = await trpcError(receptionB.call((c) => c.patients.get({ id: row!.id })));
    expect((await receptionB.call((c) => c.patients.search({ q: 'anita' }))).rows).toEqual([]);
    expect(other.code).toBe('NOT_FOUND');
  });
});

describe('registration flow (REG-01)', () => {
  it('returns duplicates instead of creating, then creates with an override reason', async () => {
    const mobile = '9415000010';
    const first = await reception.call((c) =>
      c.patients.create(form({ mobile, firstName: 'Sunita', lastName: 'Verma' })),
    );
    expect(first.status).toBe('created');

    const live = await reception.call((c) =>
      c.patients.checkDuplicates({ firstName: 'Suneeta', lastName: 'Verma', mobile, age: '31' }),
    );
    expect(live).toHaveLength(1);

    const again = await reception.call((c) =>
      c.patients.create(form({ mobile, firstName: 'Suneeta', lastName: 'Verma', age: '31' })),
    );
    expect(again.status).toBe('duplicates');
    if (again.status !== 'duplicates') return;
    expect(again.matches[0]).toMatchObject({ fullName: 'Sunita Verma' });

    const forced = await reception.call((c) =>
      c.patients.create(
        form({
          mobile,
          firstName: 'Suneeta',
          lastName: 'Verma',
          age: '31',
          duplicateOverride: { reason: 'Sisters, different people' },
        }),
      ),
    );
    expect(forced.status).toBe('created');
    if (forced.status !== 'created') return;
    const audit = await f.db.select().from(auditLog).where(eq(auditLog.rowId, forced.id));
    expect(JSON.stringify(audit[0]?.after)).toContain('Sisters, different people');
  });

  it('validates input with i18n keys, not SQL errors', async () => {
    const e1 = await trpcError(reception.call((c) => c.patients.create(form({ mobile: '12345' }))));
    expect(e1.code).toBe('BAD_REQUEST');
    const e2 = await trpcError(
      reception.call((c) => c.patients.create(form({ age: '200', mobile: '9415000020' }))),
    );
    expect(e2.code).toBe('BAD_REQUEST');
    const e3 = await trpcError(
      reception.call((c) => c.patients.create(form({ age: undefined, mobile: '9415000021' }))),
    );
    expect(e3.code).toBe('BAD_REQUEST');
    const e4 = await trpcError(
      reception.call((c) =>
        c.patients.create(form({ age: undefined, dob: '2999-01-01', mobile: '9415000022' })),
      ),
    );
    expect(e4.message).toBe('errors.patient.ageInvalid');
  });

  it('registers without a mobile when a reason is given, and skips the duplicate check', async () => {
    const out = await reception.call((c) =>
      c.patients.create(form({ mobile: undefined, noMobileReason: 'No phone in family' })),
    );
    expect(out.status).toBe('created');
  });

  it('suggests localities as you type, including learned ones', async () => {
    await reception.call((c) =>
      c.patients.create(form({ mobile: '9415000030', localityName: 'Ramnagar Colony' })),
    );
    const hits = await reception.call((c) => c.patients.localities({ q: 'ramnag' }));
    expect(hits.map((h) => h.name)).toContain('Ramnagar Colony');
  });
});
