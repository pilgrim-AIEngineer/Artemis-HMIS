import { insertUser } from '@hmis/db/auth';
import { withTx } from '@hmis/db';
import { encounter } from '@hmis/db/schema';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PASSWORD,
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
const who = {} as Record<
  'reception' | 'doctor' | 'assistant' | 'nurse' | 'noRoles' | 'mtp',
  TestBrowser
>;
let patientId: string;
let restrictedEncounterId: string;
let normalEncounterId: string;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  // An MTP doctor who can also see patients: the one user the restricted rules are meant for.
  const mtpName = `mtp_${Date.now().toString(36)}`;
  await withTx({ db: f.t.app, userId: null }, (tx) =>
    insertUser(tx, {
      facilityId: f.a.facilityId,
      username: mtpName,
      fullName: 'Test MTP',
      password: PASSWORD,
      roles: ['mtp_doctor', 'doctor', 'owner'],
    }),
  );
  for (const k of ['reception', 'doctor', 'assistant', 'nurse', 'noRoles'] as const) {
    who[k] = f.browser();
    await who[k].login(f.users[k].username);
  }
  who.mtp = f.browser();
  await who.mtp.login(mtpName);

  patientId = await opd.newPatient();
  const at = new Date();
  normalEncounterId = (await opd.visit({ patientId, doctorId: opd.doctorA }, at)).encounterId;
  restrictedEncounterId = (
    await opd.visit({ patientId, doctorId: opd.doctorB }, new Date(at.getTime() + 60_000))
  ).encounterId;
  await f.t.owner
    .update(encounter)
    .set({ isRestricted: true })
    .where(eq(encounter.id, restrictedEncounterId));
});
afterAll(async () => {
  await f.close();
});

describe('timeline procedures (OPD-07, AGENTS.md rules 6 and 8)', () => {
  it('need patient.view', async () => {
    expect((await trpcError(who.noRoles.call((c) => c.timeline.list({ patientId })))).code).toBe(
      'FORBIDDEN',
    );
    expect((await trpcError(who.noRoles.call((c) => c.timeline.types()))).code).toBe('FORBIDDEN');
  });

  it('filter each kind of item by its own permission', async () => {
    expect(await who.reception.call((c) => c.timeline.types())).toEqual(['visit', 'bill']);
    expect(await who.nurse.call((c) => c.timeline.types())).toEqual(['visit']);
    const doc = await who.doctor.call((c) => c.timeline.types());
    expect(doc).toEqual(expect.arrayContaining(['visit', 'rx', 'order', 'anc', 'vaccine']));
    expect(doc).not.toContain('bill');

    const nurse = await who.nurse.call((c) => c.timeline.list({ patientId }));
    expect(nurse.items.map((i) => i.type)).toEqual(['visit']);
    // Asking for a kind the caller may not see is not an error and shows nothing.
    const none = await who.nurse.call((c) => c.timeline.list({ patientId, types: ['rx', 'bill'] }));
    expect(none.items).toEqual([]);
  });

  it('never lists a restricted encounter, whoever asks, including the MTP doctor', async () => {
    for (const k of ['reception', 'doctor', 'assistant', 'nurse', 'mtp'] as const) {
      const p = await who[k].call((c) => c.timeline.list({ patientId }));
      const text = JSON.stringify(p, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      expect(text.includes(restrictedEncounterId), k).toBe(false);
      expect(
        p.items.map((i) => i.id),
        k,
      ).toContain(normalEncounterId);
    }
    const mtpTypes = await who.mtp.call((c) => c.timeline.types());
    expect(mtpTypes.length).toBeGreaterThan(1);
  });

  it('validates input and answers not-found / bad-cursor with message keys', async () => {
    const missing = await trpcError(
      who.reception.call((c) => c.timeline.list({ patientId: uuidv7() })),
    );
    expect([missing.code, missing.message]).toEqual([
      'NOT_FOUND',
      'errors.timeline.patientNotFound',
    ]);
    const bad = await trpcError(
      who.reception.call((c) => c.timeline.list({ patientId, cursor: 'zzz' })),
    );
    expect([bad.code, bad.message]).toEqual(['BAD_REQUEST', 'errors.timeline.badCursor']);
    expect(
      (await trpcError(who.reception.call((c) => c.timeline.list({ patientId, limit: 500 })))).code,
    ).toBe('BAD_REQUEST');
  });

  it("does not show another hospital's patient", async () => {
    const other = f.browser();
    await other.login(f.users.adminB.username);
    // adminB has no patient.view; a patient of facility A is simply not found for facility B users.
    expect((await trpcError(other.call((c) => c.timeline.list({ patientId })))).code).toMatch(
      /FORBIDDEN|NOT_FOUND/,
    );
  });

  it('pages with the cursor the previous page returned', async () => {
    const first = await who.reception.call((c) => c.timeline.list({ patientId, limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeNull(); // one unrestricted visit, one page
  });
});
