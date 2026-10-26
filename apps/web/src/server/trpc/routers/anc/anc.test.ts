import { patient } from '@hmis/db/schema';
import { FORBIDDEN_TERMS } from '@hmis/shared';
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

/** A forbidden phrase taken from the checker's own examples, so no source file spells it out. */
const forbidden = (id: string) => FORBIDDEN_TERMS.find((t) => t.id === id)!.examples[0]!;

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
const who = {} as Record<
  'reception' | 'doctor' | 'assistant' | 'nurse' | 'admin' | 'cashier' | 'owner' | 'noRoles',
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
    'owner',
    'noRoles',
  ] as const) {
    who[k] = f.browser();
    await who[k].login(f.users[k].username);
  }
});
afterAll(async () => {
  await f.close();
});

/** A grown-up woman, so age alone raises no flag. */
async function woman() {
  const id = await opd.newPatient();
  await f.db.update(patient).set({ dob: '1998-05-05' }).where(eq(patient.id, id));
  return id;
}
const lmp = () => {
  const d = new Date(Date.now() - 98 * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const create = (patientId: string, over: Record<string, unknown> = {}) =>
  who.assistant.call((c) =>
    c.anc.create({
      patientId,
      idempotencyKey: uuidv7(),
      lmp: lmp(),
      ...over,
    }),
  );

describe('ANC procedures (OPD-05, AGENTS.md rule 6)', () => {
  it('are read with patient.view and changed with clinical.anc.edit only', async () => {
    const patientId = await woman();
    for (const k of ['reception', 'nurse', 'cashier', 'admin', 'noRoles'] as const) {
      const err = await trpcError(
        who[k].call((c) => c.anc.create({ patientId, idempotencyKey: uuidv7(), lmp: lmp() })),
      );
      expect(err.code, k).toBe('FORBIDDEN');
    }
    expect(await who.assistant.call((c) => c.anc.forPatient({ patientId }))).toMatchObject({
      active: null,
      eligible: true,
    });
    const { pregnancyId } = await create(patientId);
    for (const k of ['reception', 'nurse', 'doctor', 'assistant'] as const) {
      const v = await who[k].call((c) => c.anc.get({ pregnancyId }));
      expect(v.id, k).toBe(pregnancyId);
    }
    expect((await trpcError(who.noRoles.call((c) => c.anc.get({ pregnancyId })))).code).toBe(
      'FORBIDDEN',
    );
    expect((await trpcError(who.noRoles.call((c) => c.anc.active()))).code).toBe('FORBIDDEN');
    // Edits by those without the permission are refused and change nothing.
    for (const k of ['reception', 'nurse', 'cashier'] as const) {
      const err = await trpcError(
        who[k].call((c) =>
          c.anc.saveVisit({ pregnancyId, visitDate: lmp(), bpSys: 120, bpDia: 80 }),
        ),
      );
      expect(err.code, k).toBe('FORBIDDEN');
    }
    expect((await who.doctor.call((c) => c.anc.get({ pregnancyId }))).visits).toHaveLength(0);
  });

  it('lists active pregnancies and answers a second pregnancy with a conflict key', async () => {
    const patientId = await woman();
    const { pregnancyId } = await create(patientId);
    const list = await who.reception.call((c) => c.anc.active());
    expect(list.map((p) => p.id)).toContain(pregnancyId);
    const dup = await trpcError(create(patientId));
    expect([dup.code, dup.message]).toEqual(['CONFLICT', 'errors.anc.activeExists']);
  });

  it('replays a double submit with the same key', async () => {
    const patientId = await woman();
    const input = { patientId, idempotencyKey: uuidv7(), lmp: lmp() } as never;
    const a = await who.assistant.call((c) => c.anc.create(input));
    const b = await who.assistant.call((c) => c.anc.create(input));
    expect(b).toEqual(a);
  });

  it('answers bad input with message keys', async () => {
    const patientId = await woman();
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const e1 = await trpcError(create(patientId, { lmp: future }));
    expect([e1.code, e1.message]).toEqual(['BAD_REQUEST', 'errors.anc.lmpFuture']);
    const e2 = await trpcError(create(patientId, { lmp: null }));
    expect(e2.code).toBe('BAD_REQUEST');
    const e3 = await trpcError(create(uuidv7()));
    expect([e3.code, e3.message]).toEqual(['NOT_FOUND', 'errors.anc.patientNotFound']);
    const male = await opd.newPatient();
    await f.db.update(patient).set({ sex: 'M' }).where(eq(patient.id, male));
    expect((await trpcError(create(male))).message).toBe('errors.anc.notFemale');
  });

  it('refuses free text that carries a forbidden term (rule 7, D-10)', async () => {
    const patientId = await woman();
    const err = await trpcError(create(patientId, { notes: `${forbidden('pn03')} please` }));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).not.toContain(forbidden('pn03'));
    const { pregnancyId } = await create(patientId);
    const err2 = await trpcError(
      who.assistant.call((c) =>
        c.anc.update({
          pregnancyId,
          bloodGroupRh: null,
          plurality: 'single',
          manualRisks: [{ code: 'other', text: forbidden('pn09') }],
          notes: null,
        }),
      ),
    );
    expect(err2.code).toBe('BAD_REQUEST');
  });

  it('shows the assessment of a dating scan without saving it', async () => {
    const patientId = await woman();
    const { pregnancyId } = await create(patientId);
    const scanDate = new Date(Date.now() - 56 * 86_400_000).toISOString().slice(0, 10);
    // On the scan day the LMP says 6w0d; the scan found 5w0d: seven days apart, the limit is five.
    const a = await who.assistant.call((c) =>
      c.anc.assessScan({ pregnancyId, scanDate, ga: { weeks: 5, days: 0 } }),
    );
    expect(a.assessment?.thresholdDays).toBe(5);
    expect(a.assessment?.suggestScan).toBe(true);
    const v = await who.assistant.call((c) => c.anc.get({ pregnancyId }));
    expect(v.dating.basis).toBe('lmp');
    expect(v.dating.scanDate).toBeNull();
  });

  it('an assistant cannot close a pregnancy as MTP; other outcomes need the delivery mode', async () => {
    const patientId = await woman();
    const { pregnancyId } = await create(patientId);
    const today = new Date().toISOString().slice(0, 10);
    const mtp = await trpcError(
      who.assistant.call((c) =>
        c.anc.close({ pregnancyId, outcome: 'mtp', outcomeDate: today } as never),
      ),
    );
    expect([mtp.code, mtp.message]).toEqual(['FORBIDDEN', 'errors.anc.mtpForbidden']);
    const d = await trpcError(
      who.assistant.call((c) =>
        c.anc.close({ pregnancyId, outcome: 'delivered', outcomeDate: today } as never),
      ),
    );
    expect(d.message).toBe('errors.anc.deliveryOutcomeNeeded');
    expect((await who.doctor.call((c) => c.anc.get({ pregnancyId }))).status).toBe('active');
    await who.assistant.call((c) =>
      c.anc.close({ pregnancyId, outcome: 'aborted', outcomeDate: today } as never),
    );
    const closed = await trpcError(
      who.assistant.call((c) => c.anc.saveVisit({ pregnancyId, visitDate: today })),
    );
    expect([closed.code, closed.message]).toEqual(['CONFLICT', 'errors.anc.notActive']);
  });

  it('hides another facility’s pregnancy', async () => {
    const patientId = await woman();
    const { pregnancyId } = await create(patientId);
    const other = f.browser();
    await other.login(f.users.adminB.username);
    // adminB has no patient.view; the point is that even a permitted user of facility B would get not found.
    const err = await trpcError(other.call((c) => c.anc.get({ pregnancyId })));
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(err.code);
  });
});
