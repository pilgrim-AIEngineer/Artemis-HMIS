import { opdToken, vitals } from '@hmis/db/schema';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
const who = {} as Record<
  'reception' | 'doctor' | 'assistant' | 'nurse' | 'admin' | 'cashier' | 'noRoles',
  TestBrowser
>;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  for (const k of [
    'reception',
    'doctor',
    'assistant',
    'nurse',
    'admin',
    'cashier',
    'noRoles',
  ] as const) {
    who[k] = f.browser();
    await who[k].login(f.users[k].username);
  }
});
afterAll(async () => {
  await f.close();
});

async function waiting() {
  const v = await who.reception.call(async (c) =>
    c.visit.create({
      patientId: await opd.newPatient(),
      doctorId: opd.doctorB,
      idempotencyKey: uuidv7(),
    }),
  );
  const t = await who.reception.call((c) => c.visit.issueToken({ encounterId: v.encounterId }));
  return { tokenId: t.tokenId, encounterId: v.encounterId };
}
const stateOf = async (id: string) =>
  (await f.db.select().from(opdToken).where(eq(opdToken.id, id)))[0]!.queueState;

describe('vitals procedures (OPD-01, AGENTS.md rule 6)', () => {
  it('are for vitals.record only', async () => {
    const t = await waiting();
    for (const k of ['doctor', 'cashier', 'admin', 'noRoles'] as const) {
      for (const call of [
        () => who[k].call((c) => c.vitals.desk()),
        () => who[k].call((c) => c.vitals.context({ tokenId: t.tokenId })),
        () =>
          who[k].call((c) =>
            c.vitals.record({ tokenId: t.tokenId, group: 'adult', values: { pulse: 80 } }),
          ),
      ]) {
        expect((await trpcError(call())).code).toBe('FORBIDDEN');
      }
    }
    expect(await stateOf(t.tokenId)).toBe('waiting');
    expect(
      await f.db.select().from(vitals).where(eq(vitals.encounterId, t.encounterId)),
    ).toHaveLength(0);
  });

  it('lets the nurse, assistant and reception desk take vitals', async () => {
    for (const k of ['nurse', 'assistant', 'reception'] as const) {
      const t = await waiting();
      const r = await who[k].call((c) =>
        c.vitals.record({ tokenId: t.tokenId, group: 'adult', values: { bpSys: 170, bpDia: 100 } }),
      );
      expect(r).toMatchObject({ queueState: 'vitals_done', printSheet: true, advanced: true });
      expect(r.flags).toEqual([{ code: 'bp_high', field: 'bp', level: 'red' }]);
      expect(await stateOf(t.tokenId)).toBe('vitals_done');
    }
  });

  it('shows the desk list and the form context with thresholds', async () => {
    const t = await waiting();
    const desk = await who.nurse.call((c) => c.vitals.desk());
    expect(desk.waiting.map((i) => i.tokenId)).toContain(t.tokenId);
    const ctx = await who.nurse.call((c) => c.vitals.context({ tokenId: t.tokenId }));
    expect(ctx).toMatchObject({
      token: { open: true, queueState: 'waiting' },
      allowedGroups: ['adult', 'pregnant'],
      current: null,
      heightDue: true,
      thresholds: { bpAmber: { sys: 140, dia: 90 }, spo2Amber: 94 },
    });
  });

  it('answers bad input with message keys, and bad states with conflicts', async () => {
    const t = await waiting();
    const call = (values: Record<string, unknown>, group: 'adult' | 'child' = 'adult') =>
      trpcError(who.nurse.call((c) => c.vitals.record({ tokenId: t.tokenId, group, values })));
    expect((await call({ weightKg: 650 })).message).toContain('validation.vitals.implausible');
    expect((await call({ bpSys: 100, bpDia: 100 })).message).toContain('validation.vitals.bpOrder');
    expect((await call({})).message).toContain('validation.vitals.atLeastOne');
    const mismatch = await call({ weightKg: 12 }, 'child');
    expect([mismatch.code, mismatch.message]).toEqual([
      'BAD_REQUEST',
      'errors.vitals.groupMismatch',
    ]);

    await who.doctor.call((c) => c.queue.sendIn({ tokenId: t.tokenId }));
    await who.doctor.call((c) => c.queue.markSeen({ tokenId: t.tokenId }));
    const closed = await call({ pulse: 80 });
    expect([closed.code, closed.message]).toEqual(['CONFLICT', 'errors.vitals.notAllowed']);

    const gone = await trpcError(who.nurse.call((c) => c.vitals.context({ tokenId: uuidv7() })));
    expect([gone.code, gone.message]).toEqual(['NOT_FOUND', 'errors.queue.tokenNotFound']);
  });
});
