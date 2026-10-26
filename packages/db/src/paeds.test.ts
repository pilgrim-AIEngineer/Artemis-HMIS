import {
  FORBIDDEN_TERMS,
  paedsRuleInputSchema,
  recordDoseSchema,
  recordGrowthSchema,
} from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  auditLog,
  drugPaedsRule,
  growthMeasurement,
  immunisationGiven,
  immunisationSchedule,
  messageOutbox,
  patient,
  patientConsent,
} from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { IdempotencyConflictError } from './idempotency';
import {
  cancelDose,
  cancelGrowth,
  cancelPaedsRule,
  checkDose,
  dueSoon,
  getGrowthOverview,
  getImmunisationCard,
  listPaedsRules,
  paedsRxContext,
  PaedsInputError,
  recentBatches,
  recordDose as recordRaw,
  recordGrowth as growthRaw,
  seedImmunisationSchedule,
  setImmunisationSchedule,
  setWhatsappConsent,
  syncGrowthFromVitals,
  upsertPaedsRule,
  type PaedsActor,
} from './paeds';
import { writeSetting } from './settings';

type Tx0 = Parameters<typeof recordRaw>[0];
const recordDose = (tx: Tx0, a: PaedsActor, i: unknown, now: Date) =>
  recordRaw(tx, a, recordDoseSchema.parse(i), now);
const recordGrowth = (tx: Tx0, a: PaedsActor, i: unknown, now: Date) =>
  growthRaw(tx, a, recordGrowthSchema.parse(i), now);

let fx: OpdFixture;
const NOW = IST('2026-10-26T10:00:00'); // today = 2026-10-26

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

const actor = (): PaedsActor => ({ facilityId: fx.f.facilityId, userId: fx.f.userId });
const run = <T>(fn: (tx: Tx0) => Promise<T>) => fx.run(fn);
const errKey = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) =>
      e instanceof PaedsInputError ? e.key : e instanceof Error ? e.message : String(e),
  );

/** A child of the given birth date and sex. */
async function child(
  dob: string,
  sex: 'F' | 'M' | 'O' = 'F',
  mobile: string | null = '9876543210',
) {
  const id = await fx.newPatient();
  await fx.t.owner.update(patient).set({ dob, sex, mobile }).where(eq(patient.id, id));
  return id;
}
const dose = (
  patientId: string,
  itemCode: string,
  givenOn: string,
  over: Record<string, unknown> = {},
) => ({
  idempotencyKey: uuidv7(),
  patientId,
  itemCode,
  vaccineName: itemCode,
  batchNo: 'B-100',
  expiry: '2027-12-31',
  site: 'left_thigh',
  route: 'im',
  givenOn,
  ...over,
});
const give = (patientId: string, itemCode: string, givenOn = '2026-10-26', over = {}) =>
  run((tx) => recordDose(tx, actor(), dose(patientId, itemCode, givenOn, over), NOW));
const card = (patientId: string, now = NOW) =>
  run((tx) => getImmunisationCard(tx, actor(), patientId, now));
const outbox = (patientId: string) =>
  fx.t.owner.select().from(messageOutbox).where(eq(messageOutbox.patientId, patientId));
const rowOf = (c: Awaited<ReturnType<typeof card>>, code: string) =>
  c.rows.find((r) => r.code === code)!;

describe('the immunisation card (docs/11 §4.1)', () => {
  it('starts on the facility default schedule (IAP) and computes every dose from the DOB', async () => {
    const pid = await child('2026-10-10');
    const c = await card(pid);
    expect(c.scheduleName).toBe('IAP');
    expect(c.scheduleChosen).toBe(false);
    expect(c.patient.ageDays).toBe(16);
    expect(rowOf(c, 'BCG-1').status).toBe('overdue'); // 16 days after the due date, grace 7
    expect(rowOf(c, 'DTP-1')).toMatchObject({ status: 'upcoming', dueDate: '2026-11-21' });
    expect(c.rules.signedOff).toBe(false);
    expect(c.whatsappConsent).toBeNull();
  });

  it('works from the built-in draft until the master is seeded, then from the master rows', async () => {
    const pid = await child('2026-10-10');
    // seedMasters already loaded the master; empty it to see the built-in draft.
    await fx.t.owner.delete(immunisationSchedule);
    expect((await card(pid)).rows.length).toBeGreaterThan(40);
    const n = await run((tx) => seedImmunisationSchedule(tx, fx.f.facilityId));
    expect(n).toBeGreaterThan(60);
    expect(await run((tx) => seedImmunisationSchedule(tx, fx.f.facilityId))).toBe(0);
    // The paediatrician edits the master: DTP-1 at 8 weeks instead of 6.
    await fx.t.owner
      .update(immunisationSchedule)
      .set({ dueAgeDays: 56, minAgeDays: 56 })
      .where(
        and(
          eq(immunisationSchedule.facilityId, fx.f.facilityId),
          eq(immunisationSchedule.scheduleName, 'IAP'),
          eq(immunisationSchedule.vaccineCode, 'DTP'),
          eq(immunisationSchedule.doseNo, 1),
        ),
      );
    expect(rowOf(await card(pid), 'DTP-1').dueDate).toBe('2026-12-05');
    // An inactive row is left out.
    await fx.t.owner
      .update(immunisationSchedule)
      .set({ isActive: false })
      .where(
        and(
          eq(immunisationSchedule.facilityId, fx.f.facilityId),
          eq(immunisationSchedule.vaccineCode, 'TCV'),
        ),
      );
    expect((await card(pid)).rows.some((r) => r.code === 'TCV-1')).toBe(false);
    // Put the draft back for the other tests.
    await fx.t.owner.delete(immunisationSchedule);
    await run((tx) => seedImmunisationSchedule(tx, fx.f.facilityId));
  });

  it('honours the facility settings: default schedule, grace days', async () => {
    const pid = await child('2026-09-05'); // DTP-1 due 2026-10-17, 9 days ago
    expect(rowOf(await card(pid), 'DTP-1').status).toBe('overdue');
    await run((tx) => writeSetting(tx, fx.f.facilityId, 'immunisation.overdueGraceDays', 14));
    expect(rowOf(await card(pid), 'DTP-1').status).toBe('due');
    await run((tx) => writeSetting(tx, fx.f.facilityId, 'immunisation.overdueGraceDays', 7));
    await run((tx) => writeSetting(tx, fx.f.facilityId, 'immunisation.defaultSchedule', 'UIP'));
    expect((await card(pid)).scheduleName).toBe('UIP');
    await run((tx) => writeSetting(tx, fx.f.facilityId, 'immunisation.defaultSchedule', 'IAP'));
  });

  it('answers not found for a missing, cancelled or other-facility patient', async () => {
    expect(await errKey(card(uuidv7()))).toBe('paeds.patientNotFound');
    const pid = await child('2026-10-10');
    await fx.t.owner
      .update(patient)
      .set({ status: 'cancelled', cancelReason: 'dup', cancelledAt: NOW })
      .where(eq(patient.id, pid));
    expect(await errKey(card(pid))).toBe('paeds.patientNotFound');
  });
});

describe('recording a dose with its batch', () => {
  it('stores batch, expiry, site, route and who gave it, and works out the next due date', async () => {
    const pid = await child('2026-10-10');
    const r = await give(pid, 'BCG-1', '2026-10-12', {
      brand: 'Test brand',
      batchNo: 'BCG-77',
      expiry: '2027-03-31',
      site: 'left_arm',
      route: 'id',
    });
    const [row] = await fx.t.owner
      .select()
      .from(immunisationGiven)
      .where(eq(immunisationGiven.id, r.givenId));
    expect(row).toMatchObject({
      patientId: pid,
      itemCode: 'BCG-1',
      batchNo: 'BCG-77',
      expiry: '2027-03-31',
      site: 'left_arm',
      route: 'id',
      brand: 'Test brand',
      givenOn: '2026-10-12',
      givenBy: fx.f.userId,
      status: 'active',
    });
    // The other birth doses are still outstanding, so the next due date is the (past) birth date.
    expect(r.nextDueDate).toBe('2026-10-10');
    const c = await card(pid);
    expect(rowOf(c, 'BCG-1')).toMatchObject({ status: 'given', givenOn: '2026-10-12' });
    expect(c.given).toHaveLength(1);
  });

  it('after the birth doses the next due date is the 6-week visit, listing all its vaccines', async () => {
    const pid = await child('2026-10-10');
    await give(pid, 'BCG-1', '2026-10-10');
    await give(pid, 'OPV-1', '2026-10-10');
    const r = await give(pid, 'HEPB-1', '2026-10-10');
    expect(r.nextDueDate).toBe('2026-11-21');
  });

  it('refuses a missing batch, a bad expiry date and an expired batch', async () => {
    const pid = await child('2026-10-10');
    expect(
      recordDoseSchema.safeParse(dose(pid, 'BCG-1', '2026-10-12', { batchNo: '' })).success,
    ).toBe(false);
    expect(await errKey(give(pid, 'BCG-1', '2026-10-12', { expiry: '2026-10-11' }))).toBe(
      'paeds.batchExpired',
    );
    // The same day is still fine.
    await give(pid, 'BCG-1', '2026-10-12', { expiry: '2026-10-12' });
  });

  it('refuses a date before birth or in the future, a dose already given and a code outside the schedule', async () => {
    const pid = await child('2026-10-10');
    expect(await errKey(give(pid, 'BCG-1', '2026-10-09'))).toBe('paeds.givenBeforeBirth');
    expect(await errKey(give(pid, 'BCG-1', '2026-10-27'))).toBe('paeds.givenInFuture');
    await give(pid, 'BCG-1', '2026-10-10');
    expect(await errKey(give(pid, 'BCG-1', '2026-10-11'))).toBe('paeds.doseAlreadyGiven');
    expect(await errKey(give(pid, 'ZZZ-1', '2026-10-11'))).toBe('paeds.notInSchedule');
  });

  it('asks for confirmation when a dose is early or an earlier one is missing, then records the warnings', async () => {
    const pid = await child('2026-09-05');
    const err = await run((tx) =>
      recordDose(tx, actor(), dose(pid, 'DTP-2', '2026-10-26'), NOW),
    ).catch((e: unknown) => e as PaedsInputError);
    expect(err).toBeInstanceOf(PaedsInputError);
    const asked = err as PaedsInputError;
    expect(asked.key).toBe('paeds.timingWarning');
    expect(asked.details).toEqual(expect.arrayContaining(['too_early', 'previous_dose_missing']));
    const ok = await give(pid, 'DTP-2', '2026-10-26', { confirmWarnings: true });
    const [row] = await fx.t.owner
      .select()
      .from(immunisationGiven)
      .where(eq(immunisationGiven.id, ok.givenId));
    expect(row!.warnings).toEqual(expect.arrayContaining(['too_early', 'previous_dose_missing']));
  });

  it('records a vaccine outside the schedule without a code', async () => {
    const pid = await child('2026-10-10');
    const r = await give(pid, 'X', '2026-10-12', { itemCode: null, vaccineName: 'Cholera (oral)' });
    expect((await card(pid)).given.find((g) => g.id === r.givenId)).toMatchObject({
      itemCode: null,
      vaccineName: 'Cholera (oral)',
    });
    // And a second one of the same name is allowed (no code to clash on).
    await give(pid, 'X', '2026-10-13', { itemCode: null, vaccineName: 'Cholera (oral)' });
  });

  it('is idempotent: the same key returns the first result, a different request on it conflicts', async () => {
    const pid = await child('2026-10-10');
    const input = dose(pid, 'BCG-1', '2026-10-12');
    const a = await run((tx) => recordDose(tx, actor(), input, NOW));
    const b = await run((tx) => recordDose(tx, actor(), input, NOW));
    expect(b.givenId).toBe(a.givenId);
    const rows = await fx.t.owner
      .select()
      .from(immunisationGiven)
      .where(eq(immunisationGiven.patientId, pid));
    expect(rows).toHaveLength(1);
    await expect(
      run((tx) => recordDose(tx, actor(), { ...input, batchNo: 'OTHER' }, NOW)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('two desks giving the same dose at once: one wins, the other is refused', async () => {
    const pid = await child('2026-10-10');
    const results = await Promise.allSettled([
      give(pid, 'BCG-1', '2026-10-12'),
      give(pid, 'BCG-1', '2026-10-12'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await fx.t.owner
      .select()
      .from(immunisationGiven)
      .where(eq(immunisationGiven.patientId, pid));
    expect(rows).toHaveLength(1);
  });

  it('the database itself refuses a second active record of a dose, a blank batch and an expired batch', async () => {
    const pid = await child('2026-10-10');
    await give(pid, 'BCG-1', '2026-10-12');
    const base = {
      facilityId: fx.f.facilityId,
      patientId: pid,
      scheduleName: 'IAP',
      vaccineName: 'BCG',
      expiry: '2027-01-01',
      site: 'left_arm',
      route: 'id',
      givenOn: '2026-10-12',
      givenBy: fx.f.userId,
    };
    await expect(
      fx.t.owner
        .insert(immunisationGiven)
        .values({ id: uuidv7(), ...base, itemCode: 'BCG-1', batchNo: 'X' }),
    ).rejects.toThrow();
    await expect(
      fx.t.owner
        .insert(immunisationGiven)
        .values({ id: uuidv7(), ...base, itemCode: 'MMR-1', batchNo: '  ' }),
    ).rejects.toThrow();
    await expect(
      fx.t.owner
        .insert(immunisationGiven)
        .values({ id: uuidv7(), ...base, itemCode: 'MMR-1', batchNo: 'X', expiry: '2026-10-11' }),
    ).rejects.toThrow();
  });

  it('is audited', async () => {
    const pid = await child('2026-10-10');
    const r = await give(pid, 'BCG-1', '2026-10-12');
    const rows = await fx.t.owner
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.tableName} = 'immunisation_given' and ${auditLog.rowId} = ${r.givenId}`,
      );
    expect(rows.some((a) => a.action === 'I')).toBe(true);
    expect(rows.every((a) => a.changedBy === fx.f.userId)).toBe(true);
  });

  it('checkDose previews the problems without saving', async () => {
    const pid = await child('2026-09-05');
    const res = await run((tx) =>
      checkDose(tx, actor(), { patientId: pid, itemCode: 'DTP-2', givenOn: '2026-10-26' }, NOW),
    );
    expect(res.blocking).toEqual([]);
    expect(res.warnings).toEqual(expect.arrayContaining(['too_early']));
    expect((await card(pid)).given).toHaveLength(0);
  });

  it('suggests recent unexpired batches of a vaccine', async () => {
    const pid = await child('2026-10-10');
    await give(pid, 'BCG-1', '2026-10-12', {
      vaccineName: 'BCG batch test',
      batchNo: 'Q1',
      expiry: '2027-02-01',
    });
    const pid2 = await child('2026-10-10');
    await give(pid2, 'BCG-1', '2026-10-13', {
      vaccineName: 'BCG batch test',
      batchNo: 'Q2',
      expiry: '2027-03-01',
    });
    const b = await run((tx) => recentBatches(tx, fx.f.facilityId, 'BCG batch test', '2026-10-26'));
    expect(b.map((x) => x.batchNo)).toEqual(['Q2', 'Q1']);
    expect(
      await run((tx) => recentBatches(tx, fx.f.facilityId, 'BCG batch test', '2027-02-15')),
    ).toEqual([expect.objectContaining({ batchNo: 'Q2' })]);
  });
});

describe('catch-up from the date actually given (docs/11 §4.1)', () => {
  it('a late first dose pushes the next one to given date + minimum interval', async () => {
    const pid = await child('2026-07-01'); // DTP-1 was due 2026-08-12
    await give(pid, 'BCG-1', '2026-07-01');
    await give(pid, 'OPV-1', '2026-07-01');
    await give(pid, 'HEPB-1', '2026-07-01');
    const r = await give(pid, 'DTP-1', '2026-10-26');
    const c = await card(pid);
    expect(rowOf(c, 'DTP-2').dueDate).toBe('2026-11-23');
    expect(rowOf(c, 'DTP-3').dueDate).toBe('2026-12-21');
    // Other series are untouched by it: HEPB-2 etc. still overdue from their own dates.
    expect(rowOf(c, 'HEPB-2').status).toBe('overdue');
    expect(r.nextDueDate).toBe('2026-08-12'); // the earliest outstanding compulsory dose, past
  });
  it('on-time doses keep the schedule dates', async () => {
    const pid = await child('2026-10-10');
    await give(pid, 'BCG-1', '2026-10-10');
    const c = await card(pid);
    expect(rowOf(c, 'DTP-2').dueDate).toBe('2026-12-19');
    expect(rowOf(c, 'DTP-3').dueDate).toBe('2027-01-16');
  });
});

describe('the vaccine reminder in the outbox (docs/21, E2E flow 8)', () => {
  const birthDoses = async (pid: string) => {
    await give(pid, 'BCG-1', '2026-10-10');
    await give(pid, 'OPV-1', '2026-10-10');
    return give(pid, 'HEPB-1', '2026-10-10');
  };

  it('queues nothing without a WhatsApp consent on record', async () => {
    const pid = await child('2026-10-10');
    const r = await birthDoses(pid);
    expect(r.reminder).toEqual({ queued: null, skipped: 'no_consent' });
    expect(await outbox(pid)).toHaveLength(0);
  });

  it('queues one message for the next due date, 2 days before at 10:00 IST, when consent is recorded', async () => {
    const pid = await child('2026-10-10');
    await birthDoses(pid);
    const out = await run((tx) =>
      setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW),
    );
    expect(out.skipped).toBeNull();
    const rows = await outbox(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patientId: pid,
      channel: 'whatsapp',
      templateKind: 'vaccine_reminder',
      toMobile: '9876543210',
      status: 'queued',
      language: 'hi',
      attempts: 0,
    });
    expect(rows[0]!.sendAfter.toISOString()).toBe('2026-11-19T04:30:00.000Z');
    const v = rows[0]!.variables as { vaccines: string[]; dueDate: string; childName: string };
    expect(v.dueDate).toBe('2026-11-21');
    expect(v.vaccines).toEqual(
      expect.arrayContaining(['DTP-1', 'IPV-1', 'Hib-1', 'Hep B-2', 'Rotavirus-1', 'PCV-1']),
    );
    expect(v.vaccines).not.toContain('Influenza-1');
    const [consent] = await fx.t.owner
      .select()
      .from(patientConsent)
      .where(eq(patientConsent.patientId, pid));
    expect(consent).toMatchObject({
      kind: 'whatsapp',
      granted: true,
      method: 'verbal_recorded',
      capturedBy: fx.f.userId,
    });
  });

  it('recording a dose with consent already on record queues the reminder in the same transaction', async () => {
    const pid = await child('2026-10-10');
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW));
    await give(pid, 'BCG-1', '2026-10-10');
    await give(pid, 'OPV-1', '2026-10-10');
    const r = await give(pid, 'HEPB-1', '2026-10-10');
    expect(r.reminder.queued).toMatchObject({ dueDate: '2026-11-21' });
    expect((await outbox(pid)).filter((o) => o.status === 'queued')).toHaveLength(1);
    // Saving another dose does not add a second live message for the same date.
    await give(pid, 'X', '2026-10-11', { itemCode: null, vaccineName: 'Other' });
    expect((await outbox(pid)).filter((o) => o.status === 'queued')).toHaveLength(1);
  });

  it('moves the message when a late dose pushes the next date, and cancels the old one', async () => {
    const pid = await child('2026-08-30'); // DTP-1 due 2026-10-11
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW));
    for (const c of ['BCG-1', 'OPV-1', 'HEPB-1']) await give(pid, c, '2026-08-30');
    for (const c of ['HEPB-2', 'DTP-1', 'IPV-1', 'HIB-1', 'ROTA-1', 'PCV-1'])
      await give(pid, c, '2026-10-26', { confirmWarnings: true });
    const rows = await outbox(pid);
    const queued = rows.filter((o) => o.status === 'queued');
    expect(queued).toHaveLength(1);
    // The 10-week doses: max(70 days = 2026-11-08, given + 28 = 2026-11-23).
    expect((queued[0]!.variables as { dueDate: string }).dueDate).toBe('2026-11-23');
    expect(queued[0]!.sendAfter.toISOString()).toBe('2026-11-21T04:30:00.000Z');
  });

  it('withdrawing consent cancels the queued message; granting it again queues it', async () => {
    const pid = await child('2026-10-10');
    await birthDoses(pid);
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW));
    const out = await run((tx) =>
      setWhatsappConsent(tx, actor(), { patientId: pid, granted: false }, NOW),
    );
    expect(out).toEqual({ queued: null, skipped: 'no_consent' });
    let rows = await outbox(pid);
    expect(rows.map((r) => r.status)).toEqual(['cancelled']);
    expect(rows[0]!.cancelReason).toBe('no_consent');
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW));
    rows = await outbox(pid);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    expect((await card(pid)).whatsappConsent).toBe(true);
  });

  it('queues nothing without a mobile number, and nothing when the dose is due today or past', async () => {
    const noMobile = await child('2026-10-10', 'F', null).catch(() => null);
    // `patient_mobile_or_reason` needs a reason when there is no mobile.
    const pid = await child('2026-10-10');
    await fx.t.owner
      .update(patient)
      .set({ mobile: null, noMobileReason: 'no phone' })
      .where(eq(patient.id, pid));
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW));
    const r = await birthDoses(pid);
    expect(r.reminder.skipped).toBe('no_mobile');
    expect(noMobile).toBeNull();
    const old = await child('2026-07-01');
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: old, granted: true }, NOW));
    expect((await give(old, 'BCG-1', '2026-07-01')).reminder.skipped).toBe('too_late');
    expect(await outbox(old)).toHaveLength(0);
  });

  it('a dose cancelled by mistake reopens the schedule and re-plans the message', async () => {
    const pid = await child('2026-10-10');
    await run((tx) => setWhatsappConsent(tx, actor(), { patientId: pid, granted: true }, NOW));
    await give(pid, 'BCG-1', '2026-10-10');
    await give(pid, 'OPV-1', '2026-10-10');
    const last = await give(pid, 'HEPB-1', '2026-10-10');
    expect(last.reminder.queued).not.toBeNull();
    const out = await run((tx) =>
      cancelDose(tx, actor(), { id: last.givenId, reason: 'entered on the wrong child' }, NOW),
    );
    // HEPB-1 is outstanding again (due in the past): nothing to remind about.
    expect(out.reminder.skipped).toBe('too_late');
    expect(out.nextDueDate).toBe('2026-10-10');
    const rows = await outbox(pid);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(0);
    expect(rowOf(await card(pid), 'HEPB-1').status).toBe('overdue');
    // The cancelled row is kept with who and why.
    const [row] = await fx.t.owner
      .select()
      .from(immunisationGiven)
      .where(eq(immunisationGiven.id, last.givenId));
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelReason: 'entered on the wrong child',
      cancelledBy: fx.f.userId,
    });
    // …and the same dose can be recorded again.
    await give(pid, 'HEPB-1', '2026-10-10');
    expect(
      await errKey(
        run((tx) => cancelDose(tx, actor(), { id: last.givenId, reason: 'again please' }, NOW)),
      ),
    ).toBe('paeds.doseNotFound');
  });
});

describe('IAP or UIP per child', () => {
  it('switches one child; doses already given keep counting by code', async () => {
    const pid = await child('2026-10-10');
    const other = await child('2026-10-10');
    await give(pid, 'BCG-1', '2026-10-10');
    await run((tx) =>
      setImmunisationSchedule(tx, actor(), { patientId: pid, scheduleName: 'UIP' }, NOW),
    );
    const c = await card(pid);
    expect(c).toMatchObject({ scheduleName: 'UIP', scheduleChosen: true });
    expect(rowOf(c, 'PENTA-1').dueDate).toBe('2026-11-21');
    expect(c.rows.some((r) => r.code === 'DTP-1')).toBe(false);
    expect(rowOf(c, 'BCG-1').status).toBe('given');
    expect((await card(other)).scheduleName).toBe('IAP');
    // And back; only one profile row per child.
    await run((tx) =>
      setImmunisationSchedule(tx, actor(), { patientId: pid, scheduleName: 'IAP' }, NOW),
    );
    expect((await card(pid)).scheduleName).toBe('IAP');
  });

  it('a dose is counted under the schedule the child was on', async () => {
    const pid = await child('2026-10-10');
    await run((tx) =>
      setImmunisationSchedule(tx, actor(), { patientId: pid, scheduleName: 'UIP' }, NOW),
    );
    const r = await give(pid, 'PENTA-1', '2026-10-26', { confirmWarnings: true });
    const [row] = await fx.t.owner
      .select()
      .from(immunisationGiven)
      .where(eq(immunisationGiven.id, r.givenId));
    expect(row!.scheduleName).toBe('UIP');
  });
});

describe('the desk list of children due', () => {
  it('lists children whose last dose left a next due date within the window, soonest first', async () => {
    const a = await child('2026-10-10');
    for (const c of ['BCG-1', 'OPV-1', 'HEPB-1']) await give(a, c, '2026-10-10');
    const list = await run((tx) => dueSoon(tx, fx.f.facilityId, IST('2026-11-15T10:00:00')));
    const mine = list.find((x) => x.patientId === a)!;
    expect(mine).toMatchObject({ nextDueDate: '2026-11-21', daysFromToday: 6 });
    const idx = list.findIndex((x) => x.patientId === a);
    for (let i = 1; i < list.length; i++)
      expect(list[i - 1]!.nextDueDate <= list[i]!.nextDueDate).toBe(true);
    expect(idx).toBeGreaterThanOrEqual(0);
    // Too far ahead: not listed.
    expect(
      (await run((tx) => dueSoon(tx, fx.f.facilityId, NOW))).some((x) => x.patientId === a),
    ).toBe(false);
  });
});

describe('growth measurements and WHO z-scores (docs/11 §4.2)', () => {
  const measure = (patientId: string, over: Record<string, unknown> = {}, now = NOW) =>
    run((tx) =>
      recordGrowth(
        tx,
        actor(),
        {
          idempotencyKey: uuidv7(),
          patientId,
          measuredOn: '2026-10-26',
          weightKg: 3.346,
          lengthHeightCm: 49.884,
          headCircCm: 34.462,
          ...over,
        },
        now,
      ),
    );

  it('stores the values with z-scores computed on save (a median newborn boy is about zero)', async () => {
    const pid = await child('2026-10-26', 'M');
    const r = await measure(pid);
    expect(r.zScores.skipped).toBeNull();
    expect(r.zScores.wfa).toBeCloseTo(0, 1);
    expect(r.zScores.lhfa).toBeCloseTo(0, 1);
    expect(r.zScores.hcfa).toBeCloseTo(0, 1);
    const [row] = await fx.t.owner
      .select()
      .from(growthMeasurement)
      .where(eq(growthMeasurement.id, r.id));
    expect(row).toMatchObject({
      measuredOn: '2026-10-26',
      ageDays: 0,
      source: 'paeds',
      status: 'active',
    });
    expect(Number(row!.weightKg)).toBe(3.35);
  });

  it('the same z-score is not reached for the other sex', async () => {
    const boy = await measure(await child('2026-10-26', 'M'));
    const girl = await measure(await child('2026-10-26', 'F'));
    expect(girl.zScores.wfa).not.toBe(boy.zScores.wfa);
  });

  it('a second entry for the same day replaces the first and keeps it on record', async () => {
    const pid = await child('2026-08-01', 'F');
    const first = await measure(pid, { weightKg: 5.0 });
    const second = await measure(pid, { weightKg: 5.2 });
    const view = await run((tx) => getGrowthOverview(tx, actor(), pid, NOW));
    expect(view.measurements).toHaveLength(1);
    expect(view.measurements[0]!.weightKg).toBe(5.2);
    const [old] = await fx.t.owner
      .select()
      .from(growthMeasurement)
      .where(eq(growthMeasurement.id, first.id));
    expect(old).toMatchObject({ status: 'cancelled' });
    expect(second.id).not.toBe(first.id);
  });

  it('refuses a date before birth or in the future, and implausible values at the schema', async () => {
    const pid = await child('2026-08-01', 'F');
    expect(await errKey(measure(pid, { measuredOn: '2026-07-31' }))).toBe('paeds.measuredRange');
    expect(await errKey(measure(pid, { measuredOn: '2026-10-27' }))).toBe('paeds.measuredRange');
    expect(
      recordGrowthSchema.safeParse({
        idempotencyKey: uuidv7(),
        patientId: pid,
        measuredOn: '2026-10-26',
        weightKg: 650,
        lengthHeightCm: null,
        headCircCm: null,
      }).success,
    ).toBe(false);
  });

  it('is idempotent', async () => {
    const pid = await child('2026-08-01', 'F');
    const input = {
      idempotencyKey: uuidv7(),
      patientId: pid,
      measuredOn: '2026-10-26',
      weightKg: 5.1,
      lengthHeightCm: null,
      headCircCm: null,
    };
    const a = await run((tx) => recordGrowth(tx, actor(), input, NOW));
    const b = await run((tx) => recordGrowth(tx, actor(), input, NOW));
    expect(b.id).toBe(a.id);
    const n = await fx.t.owner
      .select()
      .from(growthMeasurement)
      .where(eq(growthMeasurement.patientId, pid));
    expect(n).toHaveLength(1);
  });

  it('gives chart data for a child under 5 years: four indicators, the child as points on each', async () => {
    const pid = await child('2025-10-26', 'F');
    await measure(pid, {
      measuredOn: '2026-04-26',
      weightKg: 7.2,
      lengthHeightCm: 66,
      headCircCm: 42,
    });
    await measure(pid, {
      measuredOn: '2026-10-26',
      weightKg: 9.0,
      lengthHeightCm: 74,
      headCircCm: 45,
    });
    const v = await run((tx) => getGrowthOverview(tx, actor(), pid, NOW));
    expect(v.chartsSkipped).toBeNull();
    expect(v.charts!.map((c) => c.indicator)).toEqual(['wfa', 'lhfa', 'hcfa', 'wfh']);
    const wfa = v.charts!.find((c) => c.indicator === 'wfa')!;
    expect(wfa.points.map((p) => p.on)).toEqual(['2026-04-26', '2026-10-26']);
    expect(wfa.points[0]!.x).toBe(182);
    expect(wfa.curve.lines).toHaveLength(5);
    const wfh = v.charts!.find((c) => c.indicator === 'wfh')!;
    expect(wfh.points.map((p) => p.x)).toEqual([66, 74]);
    expect(v.measurements[0]!.bands.wfa).toBe('normal');
  });

  it('gives values only (no z-scores, no charts) at 5 years and over, and for sex "other"', async () => {
    const old = await child('2020-01-01', 'F');
    const r = await measure(old, { weightKg: 20, lengthHeightCm: 110, headCircCm: null });
    expect(r.zScores).toMatchObject({ skipped: 'age', wfa: null });
    expect((await run((tx) => getGrowthOverview(tx, actor(), old, NOW))).chartsSkipped).toBe('age');
    const other = await child('2026-01-01', 'O');
    expect((await measure(other, { weightKg: 6 })).zScores.skipped).toBe('sex');
    expect((await run((tx) => getGrowthOverview(tx, actor(), other, NOW))).chartsSkipped).toBe(
      'sex',
    );
  });

  it('a measurement cancelled by mistake stays on record with the reason', async () => {
    const pid = await child('2026-08-01', 'F');
    const m = await measure(pid, { weightKg: 5.0 });
    await run((tx) => cancelGrowth(tx, actor(), { id: m.id, reason: 'wrong child' }, NOW));
    expect((await run((tx) => getGrowthOverview(tx, actor(), pid, NOW))).measurements).toHaveLength(
      0,
    );
    expect(
      await errKey(run((tx) => cancelGrowth(tx, actor(), { id: m.id, reason: 'again' }, NOW))),
    ).toBe('paeds.growthNotFound');
    const [row] = await fx.t.owner
      .select()
      .from(growthMeasurement)
      .where(eq(growthMeasurement.id, m.id));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'wrong child' });
  });

  it("a child's vitals fill the day's measurement, a correction replaces it, a typed entry is kept", async () => {
    const pid = await child('2026-08-01', 'M');
    // The encounter reference must exist: use a real visit.
    const visit = await fx.visit({ patientId: pid }, NOW);
    const enc2 = visit.encounterId;
    const go = (w: number | null, h: number | null, hc: number | null) =>
      run((tx) =>
        syncGrowthFromVitals(
          tx,
          actor(),
          {
            patientId: pid,
            encounterId: enc2,
            measuredOn: '2026-10-26',
            weightKg: w,
            lengthHeightCm: h,
            headCircCm: hc,
          },
          NOW,
        ),
      );
    await go(null, null, null);
    expect((await run((tx) => getGrowthOverview(tx, actor(), pid, NOW))).measurements).toHaveLength(
      0,
    );
    await go(6.1, 61, 40);
    let v = await run((tx) => getGrowthOverview(tx, actor(), pid, NOW));
    expect(v.measurements).toHaveLength(1);
    expect(v.measurements[0]).toMatchObject({ weightKg: 6.1, source: 'vitals' });
    await go(6.3, 61, 40);
    v = await run((tx) => getGrowthOverview(tx, actor(), pid, NOW));
    expect(v.measurements.map((m) => m.weightKg)).toEqual([6.3]);
    await measure(pid, { weightKg: 6.5 });
    await go(6.9, 61, 40);
    v = await run((tx) => getGrowthOverview(tx, actor(), pid, NOW));
    expect(v.measurements.map((m) => [m.weightKg, m.source])).toEqual([[6.5, 'paeds']]);
  });
});

describe('weight-based dose rules (docs/11 §4.4)', () => {
  // Invented numbers for exercising the code; the real list comes from the paediatrician.
  const rule = (over: Record<string, unknown> = {}) =>
    paedsRuleInputSchema.parse({
      genericName: 'Testdrug',
      mgPerKgMin: 10,
      mgPerKgMax: 15,
      maxMgPerDose: 500,
      maxDosesPerDay: 4,
      concentrationMgPerMl: { syp: 25 },
      ...over,
    });
  const save = (r = rule()) =>
    run((tx) =>
      upsertPaedsRule(tx, actor(), { ...r, approvedBy: 'Dr. Test', approvedOn: '2026-10-01' }, NOW),
    );

  it('has no rules until the hospital enters them', async () => {
    const [c] = await fx.t.owner
      .select({ n: sql<number>`count(*)::int` })
      .from(drugPaedsRule)
      .where(eq(drugPaedsRule.facilityId, fx.f.facilityId));
    expect(c!.n).toBe(0);
    const pid = await child('2023-01-01');
    expect(await run((tx) => paedsRxContext(tx, fx.f.facilityId, pid, NOW))).toBeNull();
  });

  it('stores a rule with its approval, lower-cased; a new version replaces the old and keeps it', async () => {
    const a = await save();
    const first = (await run((tx) => listPaedsRules(tx, fx.f.facilityId)))[0]!;
    expect(first).toMatchObject({
      id: a.id,
      genericName: 'testdrug',
      mgPerKgMin: 10,
      mgPerKgMax: 15,
      maxMgPerDose: 500,
      maxDosesPerDay: 4,
      approvedBy: 'Dr. Test',
      approvedOn: '2026-10-01',
    });
    expect(first.concentrationMgPerMl).toEqual({ syp: 25 });
    const b = await save(rule({ mgPerKgMax: 20 }));
    const list = await run((tx) => listPaedsRules(tx, fx.f.facilityId));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: b.id, mgPerKgMax: 20 });
    const [old] = await fx.t.owner.select().from(drugPaedsRule).where(eq(drugPaedsRule.id, a.id));
    expect(old!.status).toBe('cancelled');
  });

  it("gives a child under 18 today's weight with the rules; an adult gets nothing", async () => {
    await save();
    const kid = await child('2023-01-01');
    const adult = await child('1990-01-01');
    expect(await run((tx) => paedsRxContext(tx, fx.f.facilityId, adult, NOW))).toBeNull();
    // No weight today yet.
    expect(await run((tx) => paedsRxContext(tx, fx.f.facilityId, kid, NOW))).toMatchObject({
      weightKg: null,
      weightOn: null,
    });
    await run((tx) =>
      recordGrowth(
        tx,
        actor(),
        {
          idempotencyKey: uuidv7(),
          patientId: kid,
          measuredOn: '2026-10-26',
          weightKg: 14,
          lengthHeightCm: null,
          headCircCm: null,
        },
        NOW,
      ),
    );
    const ctx = await run((tx) => paedsRxContext(tx, fx.f.facilityId, kid, NOW));
    expect(ctx).toMatchObject({ weightKg: 14, weightOn: '2026-10-26' });
    expect(ctx!.rules[0]).toMatchObject({ genericName: 'testdrug' });
    // Yesterday's weight is not today's.
    expect(
      await run((tx) => paedsRxContext(tx, fx.f.facilityId, kid, IST('2026-10-27T10:00:00'))),
    ).toMatchObject({ weightKg: null });
  });

  it('a rule can be withdrawn with a reason', async () => {
    const r = await save(rule({ genericName: 'otherdrug' }));
    await run((tx) =>
      cancelPaedsRule(tx, actor(), { id: r.id, reason: 'withdrawn by the paediatrician' }, NOW),
    );
    expect(
      (await run((tx) => listPaedsRules(tx, fx.f.facilityId))).some(
        (x) => x.genericName === 'otherdrug',
      ),
    ).toBe(false);
    expect(
      await errKey(run((tx) => cancelPaedsRule(tx, actor(), { id: r.id, reason: 'twice' }, NOW))),
    ).toBe('paeds.ruleNotFound');
  });

  it('the database keeps rules lower-case and ranges sane', async () => {
    const base = { id: uuidv7(), facilityId: fx.f.facilityId, mgPerKgMin: '5', mgPerKgMax: '10' };
    await expect(
      fx.t.owner.insert(drugPaedsRule).values({ ...base, genericName: 'MixedCase' }),
    ).rejects.toThrow();
    await expect(
      fx.t.owner
        .insert(drugPaedsRule)
        .values({ ...base, id: uuidv7(), genericName: 'okdrug', mgPerKgMin: '11' }),
    ).rejects.toThrow();
  });
});

describe('nothing forbidden in the paediatric tables (AGENTS.md rule 7)', () => {
  it('the paediatric tables carry no forbidden column', async () => {
    const forbiddenWords = FORBIDDEN_TERMS.flatMap((t) => t.examples).map((e) =>
      e.toLowerCase().replace(/\s+/g, '_'),
    );
    const cols = await fx.t.owner.execute(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('immunisation_schedule','immunisation_profile','immunisation_given','growth_measurement','drug_paeds_rule','patient_consent','message_outbox')`,
    );
    for (const r of cols.rows as { column_name: string }[]) {
      expect(forbiddenWords.some((w) => r.column_name.includes(w))).toBe(false);
    }
  });
});
