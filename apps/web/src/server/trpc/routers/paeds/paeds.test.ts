import { messageOutbox, patient } from '@hmis/db/schema';
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

const istDay = (offset: number) =>
  new Date(Date.now() + 5.5 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

/** A baby born `daysOld` days ago. */
async function baby(daysOld: number, sex: 'F' | 'M' = 'F') {
  const id = await opd.newPatient();
  await f.db
    .update(patient)
    .set({ dob: istDay(-daysOld), sex })
    .where(eq(patient.id, id));
  return id;
}
const doseInput = (patientId: string, itemCode: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: uuidv7(),
  patientId,
  itemCode,
  vaccineName: itemCode,
  batchNo: 'B-1',
  expiry: istDay(400),
  site: 'left_thigh' as const,
  route: 'im' as const,
  givenOn: istDay(0),
  ...over,
});

describe('paediatrics procedures (OPD-06, AGENTS.md rule 6)', () => {
  it('are read with patient.view and changed with clinical.paeds.edit only', async () => {
    const patientId = await baby(0);
    for (const k of ['reception', 'nurse', 'doctor', 'assistant'] as const) {
      const c = await who[k].call((c) => c.paeds.card({ patientId }));
      expect(c.patient.id, k).toBe(patientId);
      expect(c.scheduleName).toBe('IAP');
    }
    expect((await trpcError(who.noRoles.call((c) => c.paeds.card({ patientId })))).code).toBe(
      'FORBIDDEN',
    );
    expect((await trpcError(who.cashier.call((c) => c.paeds.dueSoon()))).code).toBe('FORBIDDEN');
    for (const k of ['reception', 'nurse', 'cashier', 'noRoles'] as const) {
      const err = await trpcError(
        who[k].call((c) => c.paeds.recordDose(doseInput(patientId, 'BCG-1'))),
      );
      expect(err.code, k).toBe('FORBIDDEN');
    }
    for (const k of ['reception', 'nurse'] as const) {
      expect(
        (await trpcError(who[k].call((c) => c.paeds.setConsent({ patientId, granted: true }))))
          .code,
        k,
      ).toBe('FORBIDDEN');
      expect(
        (
          await trpcError(
            who[k].call((c) => c.paeds.setSchedule({ patientId, scheduleName: 'UIP' })),
          )
        ).code,
        k,
      ).toBe('FORBIDDEN');
      expect(
        (
          await trpcError(
            who[k].call((c) =>
              c.paeds.recordGrowth({
                idempotencyKey: uuidv7(),
                patientId,
                measuredOn: istDay(0),
                weightKg: 3.2,
                lengthHeightCm: null,
                headCircCm: null,
              }),
            ),
          )
        ).code,
        k,
      ).toBe('FORBIDDEN');
    }
    expect((await who.doctor.call((c) => c.paeds.card({ patientId }))).given).toHaveLength(0);
  });

  it('the dose rules are masters: assistants and doctors may read the list, only masters admins write', async () => {
    const rule = {
      genericName: 'testdrug',
      mgPerKgMin: 10,
      mgPerKgMax: 15,
      maxMgPerDose: 500,
      maxDosesPerDay: 4,
      concentrationMgPerMl: { syp: 25 },
      approvedBy: 'Dr. Test',
      approvedOn: istDay(-1),
    };
    for (const k of ['assistant', 'doctor', 'reception'] as const) {
      expect((await trpcError(who[k].call((c) => c.paeds.saveDoseRule(rule)))).code, k).toBe(
        'FORBIDDEN',
      );
    }
    await who.admin.call((c) => c.paeds.saveDoseRule(rule));
    const list = await who.assistant.call((c) => c.paeds.doseRules());
    expect(list.map((r) => r.genericName)).toContain('testdrug');
    expect((await trpcError(who.reception.call((c) => c.paeds.doseRules()))).code).toBe(
      'FORBIDDEN',
    );
    const bad = await trpcError(
      who.admin.call((c) => c.paeds.saveDoseRule({ ...rule, mgPerKgMin: 20 })),
    );
    expect(bad.code).toBe('BAD_REQUEST');
    const id = list.find((r) => r.genericName === 'testdrug')!.id;
    await who.admin.call((c) => c.paeds.cancelDoseRule({ id, reason: 'test is over' }));
    expect(
      (await who.assistant.call((c) => c.paeds.doseRules())).map((r) => r.genericName),
    ).not.toContain('testdrug');
  });

  it('records a dose, shows the next due date, and replays a double submit', async () => {
    const patientId = await baby(0);
    const input = doseInput(patientId, 'BCG-1');
    const a = await who.assistant.call((c) => c.paeds.recordDose(input));
    const b = await who.assistant.call((c) => c.paeds.recordDose(input));
    expect(b).toEqual(a);
    const card = await who.doctor.call((c) => c.paeds.card({ patientId }));
    expect(card.given).toHaveLength(1);
    expect(card.given[0]).toMatchObject({ itemCode: 'BCG-1', batchNo: 'B-1' });
    expect(card.rows.find((r) => r.code === 'BCG-1')!.status).toBe('given');
    const changed = await trpcError(
      who.assistant.call((c) => c.paeds.recordDose({ ...input, batchNo: 'B-2' })),
    );
    expect([changed.code, changed.message]).toEqual(['CONFLICT', 'errors.idempotency.conflict']);
  });

  it('answers problems with message keys', async () => {
    const patientId = await baby(0);
    const give = (over: Record<string, unknown>, k: 'assistant' = 'assistant') =>
      trpcError(who[k].call((c) => c.paeds.recordDose(doseInput(patientId, 'BCG-1', over))));
    expect((await give({ givenOn: istDay(1) })).message).toBe('errors.paeds.givenInFuture');
    expect((await give({ givenOn: istDay(-1) })).message).toBe('errors.paeds.givenBeforeBirth');
    expect((await give({ expiry: istDay(-1), givenOn: istDay(0) })).message).toBe(
      'errors.paeds.batchExpired',
    );
    expect((await give({ batchNo: '' })).code).toBe('BAD_REQUEST');
    const missing = await trpcError(
      who.assistant.call((c) => c.paeds.recordDose(doseInput(uuidv7(), 'BCG-1'))),
    );
    expect([missing.code, missing.message]).toEqual(['NOT_FOUND', 'errors.paeds.patientNotFound']);
    const early = await trpcError(
      who.assistant.call((c) => c.paeds.recordDose(doseInput(patientId, 'DTP-2'))),
    );
    expect([early.code, early.message]).toEqual(['CONFLICT', 'errors.paeds.timingWarning']);
    // After the person confirms, it is recorded with the warnings.
    await who.assistant.call((c) =>
      c.paeds.recordDose(doseInput(patientId, 'DTP-2', { confirmWarnings: true })),
    );
    await who.assistant.call((c) => c.paeds.recordDose(doseInput(patientId, 'BCG-1')));
    const dup = await give({});
    expect([dup.code, dup.message]).toEqual(['CONFLICT', 'errors.paeds.doseAlreadyGiven']);
  });

  it('previews timing problems without saving', async () => {
    const patientId = await baby(0);
    const r = await who.assistant.call((c) =>
      c.paeds.checkDose({ patientId, itemCode: 'DTP-1', givenOn: istDay(0) }),
    );
    expect(r.warnings).toContain('too_early');
    expect((await who.assistant.call((c) => c.paeds.card({ patientId }))).given).toHaveLength(0);
  });

  it('queues the vaccine reminder only after the family agreed, and cancels it when they withdraw', async () => {
    const patientId = await baby(0);
    for (const c of ['BCG-1', 'OPV-1', 'HEPB-1']) {
      await who.assistant.call((x) => x.paeds.recordDose(doseInput(patientId, c)));
    }
    const rows = () =>
      f.db.select().from(messageOutbox).where(eq(messageOutbox.patientId, patientId));
    expect(await rows()).toHaveLength(0);
    const on = await who.assistant.call((c) => c.paeds.setConsent({ patientId, granted: true }));
    expect(on.queued).toMatchObject({ dueDate: istDay(42) });
    const queued = await rows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'queued', templateKind: 'vaccine_reminder' });
    const card = await who.reception.call((c) => c.paeds.card({ patientId }));
    expect(card.whatsappConsent).toBe(true);
    expect(card.reminders).toHaveLength(1);
    await who.assistant.call((c) => c.paeds.setConsent({ patientId, granted: false }));
    expect((await rows())[0]!.status).toBe('cancelled');
  });

  it('switches the schedule per child', async () => {
    const patientId = await baby(0);
    await who.doctor.call((c) => c.paeds.setSchedule({ patientId, scheduleName: 'UIP' }));
    expect((await who.assistant.call((c) => c.paeds.card({ patientId }))).scheduleName).toBe('UIP');
  });

  it('cancels a dose with a reason and lists children due soon', async () => {
    const patientId = await baby(0);
    const r = await who.assistant.call((c) => c.paeds.recordDose(doseInput(patientId, 'BCG-1')));
    const err = await trpcError(
      who.assistant.call((c) => c.paeds.cancelDose({ id: r.givenId, reason: 'x' })),
    );
    expect(err.code).toBe('BAD_REQUEST');
    await who.assistant.call((c) => c.paeds.cancelDose({ id: r.givenId, reason: 'wrong child' }));
    expect((await who.assistant.call((c) => c.paeds.card({ patientId }))).given).toHaveLength(0);
    const again = await trpcError(
      who.assistant.call((c) => c.paeds.cancelDose({ id: r.givenId, reason: 'wrong child' })),
    );
    expect([again.code, again.message]).toEqual(['NOT_FOUND', 'errors.paeds.doseNotFound']);
    // A 5-week-old whose birth doses are in: the 6-week visit is a week away.
    const older = await baby(35);
    for (const c of ['BCG-1', 'OPV-1', 'HEPB-1']) {
      await who.assistant.call((x) =>
        x.paeds.recordDose(doseInput(older, c, { givenOn: istDay(-35) })),
      );
    }
    const due = await who.reception.call((c) => c.paeds.dueSoon());
    expect(due.find((d) => d.patientId === older)).toMatchObject({
      nextDueDate: istDay(7),
      daysFromToday: 7,
    });
    expect(due.some((d) => d.patientId === patientId)).toBe(false);
  });

  it('records growth and answers with z-scores, charts and bands', async () => {
    const patientId = await baby(200, 'M');
    const r = await who.assistant.call((c) =>
      c.paeds.recordGrowth({
        idempotencyKey: uuidv7(),
        patientId,
        measuredOn: istDay(0),
        weightKg: 7.9,
        lengthHeightCm: 68,
        headCircCm: 43.5,
      }),
    );
    expect(r.zScores.wfa).not.toBeNull();
    const g = await who.nurse.call((c) => c.paeds.growth({ patientId }));
    expect(g.measurements).toHaveLength(1);
    expect(g.charts?.map((c) => c.indicator)).toEqual(['wfa', 'lhfa', 'hcfa', 'wfh']);
    expect(g.measurements[0]!.bands.wfa).toBeDefined();
    const bad = await trpcError(
      who.assistant.call((c) =>
        c.paeds.recordGrowth({
          idempotencyKey: uuidv7(),
          patientId,
          measuredOn: istDay(1),
          weightKg: 8,
          lengthHeightCm: null,
          headCircCm: null,
        }),
      ),
    );
    expect([bad.code, bad.message]).toEqual(['BAD_REQUEST', 'errors.paeds.measuredRange']);
    const heavy = await trpcError(
      who.assistant.call((c) =>
        c.paeds.recordGrowth({
          idempotencyKey: uuidv7(),
          patientId,
          measuredOn: istDay(0),
          weightKg: 650,
          lengthHeightCm: null,
          headCircCm: null,
        }),
      ),
    );
    expect(heavy.code).toBe('BAD_REQUEST');
    await who.assistant.call((c) => c.paeds.cancelGrowth({ id: r.id, reason: 'wrong child' }));
    expect((await who.nurse.call((c) => c.paeds.growth({ patientId }))).measurements).toHaveLength(
      0,
    );
  });

  it('refuses free text that carries a forbidden term (rule 7, D-10)', async () => {
    const patientId = await baby(0);
    const err = await trpcError(
      who.assistant.call((c) =>
        c.paeds.recordDose(doseInput(patientId, 'BCG-1', { brand: forbidden('pn03') })),
      ),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).not.toContain(forbidden('pn03'));
    const r = await who.assistant.call((c) => c.paeds.recordDose(doseInput(patientId, 'BCG-1')));
    const err2 = await trpcError(
      who.assistant.call((c) => c.paeds.cancelDose({ id: r.givenId, reason: forbidden('pn09') })),
    );
    expect(err2.code).toBe('BAD_REQUEST');
  });

  it('hides another facility’s child', async () => {
    const patientId = await baby(0);
    const other = f.browser();
    await other.login(f.users.adminB.username);
    const err = await trpcError(other.call((c) => c.paeds.card({ patientId })));
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(err.code);
  });
});
