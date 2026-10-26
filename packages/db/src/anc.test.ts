import {
  closePregnancySchema,
  confirmDatingSchema,
  createPregnancySchema,
  markScheduleSchema,
  saveAncVisitSchema,
  saveHistorySchema,
  setGpalSchema,
  updatePregnancySchema,
} from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  accessLog,
  ancVisit,
  auditLog,
  clinicalOrder,
  encounter,
  obstetricHistory,
  patient,
  patientAlert,
  pregnancy,
  service,
} from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import {
  activePregnancies,
  AncInputError,
  assessScan,
  cancelAncVisit,
  closePregnancy as closeRaw,
  confirmDating as confirmRaw,
  createPregnancy as createRaw,
  getPregnancyView,
  markScheduleItem as markRaw,
  patientAnc,
  saveAncVisit as saveVisitRaw,
  saveHistory as saveHistoryRaw,
  setGpal as setGpalRaw,
  updatePregnancy as updateRaw,
  ancSummary,
  type AncActor,
} from './anc';
import { issueToken } from './visits';
import { recordVitals } from './vitals';

type Tx0 = Parameters<typeof closeRaw>[0];
type A0 = Parameters<typeof closeRaw>[1];
// The router parses with the zod schema; so do these wrappers, with the same inputs the screens send.
const createPregnancy = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  createRaw(tx, a, createPregnancySchema.parse(i), now);
const confirmDating = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  confirmRaw(tx, a, confirmDatingSchema.parse(i), now);
const updatePregnancy = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  updateRaw(tx, a, updatePregnancySchema.parse(i), now);
const saveHistory = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  saveHistoryRaw(tx, a, saveHistorySchema.parse(i), now);
const setGpal = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  setGpalRaw(tx, a, setGpalSchema.parse(i), now);
const saveAncVisit = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  saveVisitRaw(tx, a, saveAncVisitSchema.parse(i), now);
const markScheduleItem = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  markRaw(tx, a, markScheduleSchema.parse(i), now);
const closePregnancy = (tx: Tx0, a: A0, i: unknown, now: Date) =>
  closeRaw(tx, a, closePregnancySchema.parse(i), now);

let fx: OpdFixture;
const NOW = IST('2026-10-26T10:00:00'); // today = 2026-10-26
const LMP = '2026-07-20'; // 14w0d today, EDD 2027-04-26

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

const actor = (mtp = { view: false, edit: false }): AncActor => ({
  facilityId: fx.f.facilityId,
  userId: fx.f.userId,
  mtp,
});
/** The database's own message: drizzle wraps it as the `cause` of a "Failed query" error. */
const dbMessage = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: { message: string; cause?: { message?: string } }) => e.cause?.message ?? e.message,
  );
const run = <T>(fn: (tx: Parameters<Parameters<typeof fx.run>[0]>[0]) => Promise<T>) => fx.run(fn);
const errKey = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof AncInputError ? e.key : String(e)),
  );

async function start(
  over: Partial<Parameters<typeof createPregnancy>[2]> = {},
  patientId?: string,
) {
  const pid = patientId ?? (await fx.newPatient());
  // Young enough that age alone raises no flag (the fixture patient is 36).
  if (!patientId) {
    await fx.t.owner.update(patient).set({ dob: '1998-05-05' }).where(eq(patient.id, pid));
  }
  const r = await run((tx) =>
    createPregnancy(
      tx,
      actor(),
      { patientId: pid, idempotencyKey: uuidv7(), lmp: LMP, ...over },
      NOW,
    ),
  );
  return { patientId: pid, pregnancyId: r.pregnancyId };
}
const view = (id: string, a = actor()) => run((tx) => getPregnancyView(tx, a, id, NOW));
const visit = (pregnancyId: string, over: Record<string, unknown> = {}) =>
  run((tx) =>
    saveAncVisit(tx, actor(), { pregnancyId, visitDate: '2026-10-26', ...over } as never, NOW),
  );

describe('opening a pregnancy record (docs/11 §3.1)', () => {
  it('derives EDD and GA from the LMP and starts at G1 P0 A0 L0', async () => {
    const { pregnancyId } = await start();
    const v = await view(pregnancyId);
    expect(v.dating).toMatchObject({
      lmp: LMP,
      eddByLmp: '2027-04-26',
      eddFinal: '2027-04-26',
      basis: 'lmp',
      redatingPending: false,
    });
    expect(v.ga).toMatchObject({ days: 98, label: '14w 0d', trimester: 2 });
    expect(v.gpal.text).toBe('G1 P0 A0 L0');
    expect(v.status).toBe('active');
    expect(v.bookingDate).toBe('2026-10-26');
    expect(v.rulesSignedOff).toBe(false);
  });

  it('can be dated by a scan when the LMP is unknown', async () => {
    const { pregnancyId } = await start({
      lmp: null,
      scan: { date: '2026-10-01', ga: { weeks: 10, days: 0 } } as never,
    });
    const v = await view(pregnancyId);
    // 10w0d on 1 Oct → 40w0d is 210 days later.
    expect(v.dating).toMatchObject({ lmp: null, eddByScan: '2027-04-29', basis: 'scan' });
    expect(v.ga?.days).toBe(70 + 25);
  });

  it('refuses an LMP in the future, one older than 44 weeks, and neither LMP nor scan', async () => {
    expect(await errKey(start({ lmp: '2026-10-27' }))).toBe('anc.lmpFuture');
    expect(await errKey(start({ lmp: '2025-12-01' }))).toBe('anc.lmpTooOld');
    expect(await errKey(start({ lmp: null }))).toMatch(/datingNeeded|ZodError/);
  });

  it('refuses a male patient', async () => {
    const pid = await fx.newPatient();
    await fx.t.owner.update(patient).set({ sex: 'M' }).where(eq(patient.id, pid));
    expect(await errKey(start({}, pid))).toBe('anc.notFemale');
  });

  it('allows only one active pregnancy per patient (invariant 04 §15.4)', async () => {
    const { patientId } = await start();
    expect(await errKey(start({}, patientId))).toBe('anc.activeExists');
    // The database says the same, whatever the app does.
    const second = fx.t.owner.insert(pregnancy).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      patientId,
      lmp: LMP,
      eddByLmp: '2027-04-26',
      eddFinal: '2027-04-26',
      datingBasis: 'lmp',
      bookingDate: '2026-10-26',
    });
    expect(await dbMessage(second)).toMatch(/pregnancy_one_active_key/);
  });

  it('two desks opening the same woman at once: exactly one wins', async () => {
    const pid = await fx.newPatient();
    const results = await Promise.allSettled([start({}, pid), start({}, pid)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await fx.t.owner.select().from(pregnancy).where(eq(pregnancy.patientId, pid));
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('a double submit with the same key returns the same record', async () => {
    const pid = await fx.newPatient();
    const key = uuidv7();
    const input = { patientId: pid, idempotencyKey: key, lmp: LMP };
    const a = await run((tx) => createPregnancy(tx, actor(), input, NOW));
    const b = await run((tx) => createPregnancy(tx, actor(), input, NOW));
    expect(b).toEqual(a);
    const rows = await fx.t.owner.select().from(pregnancy).where(eq(pregnancy.patientId, pid));
    expect(rows).toHaveLength(1);
  });

  it('is audited by the table trigger', async () => {
    const { pregnancyId } = await start();
    const [n] = await fx.t.owner
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'pregnancy' and ${auditLog.rowId} = ${pregnancyId}`);
    expect(n!.n).toBeGreaterThanOrEqual(1);
  });

  it('the database refuses an EDD that is not LMP + 280 days', async () => {
    const pid = await fx.newPatient();
    const bad = fx.t.owner.insert(pregnancy).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      patientId: pid,
      lmp: LMP,
      eddByLmp: '2027-04-27',
      eddFinal: '2027-04-27',
      datingBasis: 'lmp',
      bookingDate: '2026-10-26',
    });
    expect(await dbMessage(bad)).toMatch(/pregnancy_lmp_edd/);
  });
});

describe('G P A L (docs/11 §3.1)', () => {
  const history = [
    { year: 2018, outcome: 'nvd', gestationWeeks: 39, babiesAlive: 1 },
    { year: 2021, outcome: 'lscs', gestationWeeks: 38, babiesAlive: 1 },
    { year: 2023, outcome: 'abortion', gestationWeeks: 8, babiesAlive: 0 },
  ].map((h) => ({ place: null, complications: null, neonatalDeath: false, ...h }));

  it('is computed from the earlier pregnancies plus this one, and edits recompute it', async () => {
    const { pregnancyId } = await start({ history: history as never });
    let v = await view(pregnancyId);
    expect(v.gpal).toMatchObject({ g: 4, p: 2, a: 1, l: 2, manual: false });
    expect(v.history.map((h) => h.outcome)).toEqual(['nvd', 'lscs', 'abortion']);
    // Previous LSCS is an auto risk flag.
    expect(v.risks.map((r) => r.code)).toContain('previous_lscs');

    await run((tx) =>
      saveHistory(tx, actor(), { pregnancyId, history: history.slice(0, 1) as never }, NOW),
    );
    v = await view(pregnancyId);
    expect(v.gpal).toMatchObject({ g: 2, p: 1, a: 0, l: 1 });
    expect(v.risks.map((r) => r.code)).not.toContain('previous_lscs');
    // The replaced rows stay on record, cancelled.
    const all = await fx.t.owner
      .select()
      .from(obstetricHistory)
      .where(eq(obstetricHistory.patientId, v.patient.id));
    expect(all.filter((h) => h.status === 'cancelled')).toHaveLength(3);
    expect(all.filter((h) => h.status === 'active')).toHaveLength(1);
  });

  it('can be typed by hand, must add up, and is restored from the history on request', async () => {
    const { pregnancyId } = await start({ history: history as never });
    expect(
      await errKey(
        run((tx) =>
          setGpal(tx, actor(), { pregnancyId, manual: true, g: 2, p: 2, a: 1, l: 1 }, NOW),
        ),
      ),
    ).toBe('anc.gpalInconsistent');
    await run((tx) =>
      setGpal(tx, actor(), { pregnancyId, manual: true, g: 6, p: 3, a: 2, l: 3 }, NOW),
    );
    let v = await view(pregnancyId);
    expect(v.gpal).toMatchObject({ g: 6, p: 3, a: 2, l: 3, manual: true });
    // A history edit does not overwrite the typed score.
    await run((tx) => saveHistory(tx, actor(), { pregnancyId, history: [] }, NOW));
    expect((await view(pregnancyId)).gpal.g).toBe(6);
    await run((tx) => setGpal(tx, actor(), { pregnancyId, manual: false }, NOW));
    v = await view(pregnancyId);
    expect(v.gpal).toMatchObject({ g: 1, p: 0, a: 0, l: 0, manual: false });
  });
});

describe('scan re-dating (docs/11 §3.1)', () => {
  it('suggests the scan EDD past the threshold, and only confirming changes edd_final', async () => {
    const { pregnancyId } = await start();
    // Scan on 2026-09-01: LMP says 6w1d (43 days). The scan says 5w0d (35 days): 8 days apart, limit 5.
    const input = { pregnancyId, scanDate: '2026-09-01', ga: 35 };
    const a = await run((tx) => assessScan(tx, fx.f.facilityId, input));
    expect(a.assessment).toMatchObject({
      differenceDays: 8,
      thresholdDays: 5,
      suggestScan: true,
      eddByLmp: '2027-04-26',
      eddByScan: '2027-05-04',
    });
    // Nothing was saved by looking.
    expect((await view(pregnancyId)).dating.eddFinal).toBe('2027-04-26');

    // A visit saved before the change gets its GA recomputed with the new EDD.
    await visit(pregnancyId, { visitDate: '2026-10-05' });
    expect((await view(pregnancyId)).visits[0]!.gaDays).toBe(77);

    await run((tx) =>
      confirmDating(
        tx,
        actor(),
        { pregnancyId, basis: 'scan', scanDate: '2026-09-01', ga: { weeks: 5, days: 0 } } as never,
        NOW,
      ),
    );
    const v = await view(pregnancyId);
    expect(v.dating).toMatchObject({
      eddFinal: '2027-05-04',
      eddByLmp: '2027-04-26',
      basis: 'scan',
      decision: 'switched_to_scan',
      redatingPending: false,
    });
    expect(v.ga?.days).toBe(98 - 8);
    expect(v.visits[0]!.gaDays).toBe(77 - 8);
    // The change of EDD is in the audit trail with the old and the new date.
    const rows = await fx.t.owner
      .select()
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'pregnancy' and ${auditLog.rowId} = ${pregnancyId}`);
    const upd = rows.find((r) => r.action === 'U');
    expect(JSON.stringify(upd?.before)).toContain('2027-04-26');
    expect(JSON.stringify(upd?.after)).toContain('2027-05-04');
  });

  it('keeps the LMP when the difference is within the threshold, and remembers the decision', async () => {
    const { pregnancyId } = await start();
    // LMP GA on 2026-09-01 is 43 days; scan says 6w0d = 42 → 1 day apart.
    await run((tx) =>
      confirmDating(
        tx,
        actor(),
        { pregnancyId, basis: 'lmp', scanDate: '2026-09-01', ga: { weeks: 6, days: 0 } } as never,
        NOW,
      ),
    );
    const v = await view(pregnancyId);
    expect(v.dating).toMatchObject({
      eddFinal: '2027-04-26',
      basis: 'lmp',
      decision: 'kept_lmp',
      eddByScan: '2027-04-27',
    });
    expect(v.dating.redating).toMatchObject({ suggestScan: false, differenceDays: 1 });
  });

  it('a scan entered with the LMP at creation leaves the suggestion pending until someone decides', async () => {
    const { pregnancyId } = await start({
      scan: { date: '2026-09-01', ga: { weeks: 5, days: 0 } } as never,
    });
    const v = await view(pregnancyId);
    expect(v.dating.eddFinal).toBe('2027-04-26');
    expect(v.dating.redatingPending).toBe(true);
    await run((tx) =>
      confirmDating(
        tx,
        actor(),
        { pregnancyId, basis: 'lmp', scanDate: '2026-09-01', ga: { weeks: 5, days: 0 } } as never,
        NOW,
      ),
    );
    expect((await view(pregnancyId)).dating.redatingPending).toBe(false);
  });

  it('refuses the LMP basis when there is no LMP, a scan in the future or before the LMP', async () => {
    const noLmp = await start({
      lmp: null,
      scan: { date: '2026-10-01', ga: { weeks: 10, days: 0 } } as never,
    });
    expect(
      await errKey(
        run((tx) =>
          confirmDating(
            tx,
            actor(),
            {
              pregnancyId: noLmp.pregnancyId,
              basis: 'lmp',
              scanDate: '2026-10-01',
              ga: { weeks: 10, days: 0 },
            } as never,
            NOW,
          ),
        ),
      ),
    ).toBe('anc.datingBasisMissing');
    const { pregnancyId } = await start();
    const c = (scanDate: string) =>
      errKey(
        run((tx) =>
          confirmDating(
            tx,
            actor(),
            { pregnancyId, basis: 'scan', scanDate, ga: { weeks: 8, days: 0 } } as never,
            NOW,
          ),
        ),
      );
    expect(await c('2026-10-27')).toBe('anc.scanInFuture');
    expect(await c('2026-07-19')).toBe('anc.scanBeforeLmp');
  });
});

describe('ANC visits, risk flags and the high-risk alert (docs/11 §3.2–3.3)', () => {
  const alertOf = async (patientId: string) =>
    (
      await fx.t.owner.select().from(patientAlert).where(eq(patientAlert.patientId, patientId))
    ).filter((a) => a.active);

  it('a raised BP at any visit flags the pregnancy and raises a patient alert; removing the visit clears both', async () => {
    const { patientId, pregnancyId } = await start();
    await visit(pregnancyId, { visitDate: '2026-09-28', bpSys: 150, bpDia: 96, weightKg: 58.5 });
    await visit(pregnancyId, { visitDate: '2026-10-26', bpSys: 118, bpDia: 76, weightKg: 60 });
    let v = await view(pregnancyId);
    expect(v.risks).toContainEqual({
      code: 'raised_bp',
      level: 'warn',
      source: 'auto',
      value: '150/96',
    });
    expect(v.highRisk).toBe(true);
    const alerts = await alertOf(patientId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'high_risk_pregnancy', pregnancyId });
    expect(alerts[0]!.details).toContain('raised_bp');
    expect(v.visits.map((x) => x.gaLabel)).toEqual(['10w 0d', '14w 0d']);
    expect(v.weightSeries.map((w) => w.weightKg)).toEqual([58.5, 60]);

    await run((tx) =>
      cancelAncVisit(
        tx,
        actor(),
        { pregnancyId, visitId: v.visits[0]!.id, reason: 'entered on wrong woman' },
        NOW,
      ),
    );
    v = await view(pregnancyId);
    expect(v.risks).toEqual([]);
    expect(v.visits).toHaveLength(1);
    expect(await alertOf(patientId)).toHaveLength(0);
    // The cancelled visit is still on record.
    const rows = await fx.t.owner
      .select()
      .from(ancVisit)
      .where(eq(ancVisit.pregnancyId, pregnancyId));
    expect(rows.find((r) => r.status === 'cancelled')?.cancelReason).toBe('entered on wrong woman');
  });

  it('saving a date twice updates that visit instead of adding a second', async () => {
    const { pregnancyId } = await start();
    await visit(pregnancyId, { bpSys: 120, bpDia: 80 });
    await visit(pregnancyId, {
      bpSys: 120,
      bpDia: 80,
      fundalHeightCm: 14,
      fhr: 150,
      hb: 10.2,
      presentation: 'cephalic',
    });
    const v = await view(pregnancyId);
    expect(v.visits).toHaveLength(1);
    expect(v.visits[0]).toMatchObject({ fundalHeightCm: 14, fhr: 150, hb: 10.2 });
    // Hb 10.2 is below 11.
    expect(v.risks.map((r) => r.code)).toContain('anaemia');
  });

  it('refuses a visit before conception or in the future, and one for another woman’s encounter', async () => {
    const { pregnancyId } = await start();
    expect(await errKey(visit(pregnancyId, { visitDate: '2026-10-27' }))).toBe(
      'anc.visitDateRange',
    );
    expect(await errKey(visit(pregnancyId, { visitDate: '2026-06-01' }))).toBe(
      'anc.visitDateRange',
    );
    const other = await fx.newPatient();
    const enc = await fx.visit({ patientId: other, doctorId: fx.doctorB }, NOW);
    expect(await errKey(visit(pregnancyId, { encounterId: enc.encounterId }))).toBe(
      'anc.encounterMismatch',
    );
  });

  it('manual flags are kept until removed; BMI, height, Rh and age drive the others', async () => {
    const { pregnancyId } = await start({ bloodGroupRh: 'O-' } as never);
    await run((tx) =>
      updatePregnancy(
        tx,
        actor(),
        {
          pregnancyId,
          bloodGroupRh: 'O-',
          plurality: 'twins',
          manualRisks: [
            { code: 'gdm', text: null },
            { code: 'other', text: 'Epilepsy on treatment' },
          ],
          notes: null,
        },
        NOW,
      ),
    );
    const v = await view(pregnancyId);
    expect(v.risks.map((r) => `${r.source}:${r.code}`)).toEqual([
      'auto:rh_negative',
      'auto:multiple_pregnancy',
      'manual:gdm',
      'manual:other',
    ]);
    expect(v.risks.find((r) => r.code === 'other')?.text).toBe('Epilepsy on treatment');
    await run((tx) =>
      updatePregnancy(
        tx,
        actor(),
        { pregnancyId, bloodGroupRh: 'O-', plurality: 'single', manualRisks: [], notes: null },
        NOW,
      ),
    );
    expect((await view(pregnancyId)).risks.map((r) => r.code)).toEqual(['rh_negative']);
  });

  it('flags post-dates once the GA passes 40w', async () => {
    const { pregnancyId } = await start({ lmp: '2026-01-20' });
    const v = await view(pregnancyId); // 279 days
    expect(v.ga?.days).toBe(279);
    expect(v.risks.map((r) => r.code)).not.toContain('post_dates');
    const later = await run((tx) =>
      getPregnancyView(tx, actor(), pregnancyId, IST('2026-10-28T10:00:00')),
    );
    expect(later.ga?.days).toBe(281);
    expect(later.risks.map((r) => r.code)).toContain('post_dates');
  });

  it('rejects free text that carries a forbidden term, and a BP with the diastolic above the systolic', async () => {
    const { pregnancyId } = await start();
    const bad = await errKey(visit(pregnancyId, { remarks: 'fetal sex requested' }));
    expect(bad).toMatch(/ZodError|forbidden/i);
    expect(await errKey(visit(pregnancyId, { bpSys: 80, bpDia: 90 }))).toMatch(/ZodError|bpPair/);
  });
});

describe('vitals flow into the ANC visit (docs/11 §3.3)', () => {
  it('a pregnant-form reading fills today’s visit row, flags raised BP and links the encounter', async () => {
    const { patientId, pregnancyId } = await start();
    const v = await fx.visit({ patientId, doctorId: fx.doctorB, visitType: 'anc' }, NOW);
    const tok = await run((tx) =>
      issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', NOW),
    );
    await run((tx) =>
      recordVitals(
        tx,
        fx.actor() as never,
        {
          tokenId: tok.tokenId,
          group: 'pregnant',
          values: {
            bpSys: 152,
            bpDia: 98,
            weightKg: 61.2,
            fundalHeightCm: 15,
            fhr: 148,
            oedema: 'plus1',
            urineAlbumin: 'trace',
          },
        },
        NOW,
      ),
    );
    const out = await view(pregnancyId);
    expect(out.visits).toHaveLength(1);
    expect(out.visits[0]).toMatchObject({
      encounterId: v.encounterId,
      bpSys: 152,
      bpDia: 98,
      weightKg: 61.2,
      fundalHeightCm: 15,
      fhr: 148,
      oedema: 'plus1',
      urineProtein: 'trace',
      gaDays: 98,
    });
    expect(out.risks.map((r) => r.code)).toContain('raised_bp');
    const [enc] = await fx.t.owner.select().from(encounter).where(eq(encounter.id, v.encounterId));
    expect(enc!.pregnancyId).toBe(pregnancyId);

    // The assistant completes the row; a vitals correction keeps what she added.
    await visit(pregnancyId, {
      encounterId: v.encounterId,
      bpSys: 152,
      bpDia: 98,
      weightKg: 61.2,
      presentation: 'cephalic',
      remarks: 'Fe tablets given',
    });
    await run((tx) =>
      recordVitals(
        tx,
        fx.actor() as never,
        {
          tokenId: tok.tokenId,
          group: 'pregnant',
          values: { bpSys: 140, bpDia: 90, weightKg: 61.2 },
        },
        NOW,
      ),
    );
    const after = await view(pregnancyId);
    expect(after.visits).toHaveLength(1);
    expect(after.visits[0]).toMatchObject({
      bpSys: 140,
      presentation: 'cephalic',
      remarks: 'Fe tablets given',
      fundalHeightCm: null,
    });
  });

  it('an adult-form reading of a woman with no pregnancy record creates nothing', async () => {
    const pid = await fx.newPatient();
    const v = await fx.visit({ patientId: pid, doctorId: fx.doctorB }, NOW);
    const tok = await run((tx) =>
      issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', NOW),
    );
    await run((tx) =>
      recordVitals(
        tx,
        fx.actor() as never,
        { tokenId: tok.tokenId, group: 'adult', values: { bpSys: 120, bpDia: 80 } },
        NOW,
      ),
    );
    expect(
      await fx.t.owner.select().from(pregnancy).where(eq(pregnancy.patientId, pid)),
    ).toHaveLength(0);
  });
});

describe('schedule (docs/11 §3.4, docs/33 §4)', () => {
  const stateOf = async (pregnancyId: string, code: string) =>
    (await view(pregnancyId)).schedule.find((i) => i.code === code)!;

  it('computes due, overdue and upcoming from the GA and the booking date', async () => {
    const { pregnancyId } = await start(); // 14w0d, booked today
    const v = await view(pregnancyId);
    const by = Object.fromEntries(v.schedule.map((i) => [i.code, i.state]));
    expect(by.cbc_hb).toBe('due'); // booking tests, just booked
    expect(by.dating_scan).toBe('overdue'); // window ended at 13w6d
    expect(by.nt_scan).toBe('overdue');
    expect(by.anomaly_scan).toBe('upcoming'); // from 18w0d
    expect(by.coombs_anti_d).toBe('not_applicable'); // Rh unknown
    expect(by.td_2).toBe('upcoming');
    expect(by.iron_folic).toBe('due'); // from 14w0d
  });

  it('ticking an item by hand marks it done, Td-2 follows Td-1 by four weeks, and it can be undone', async () => {
    const { pregnancyId } = await start();
    await run((tx) =>
      markScheduleItem(
        tx,
        actor(),
        { pregnancyId, code: 'td_1', status: 'done', doneDate: '2026-10-26' },
        NOW,
      ),
    );
    expect(await stateOf(pregnancyId, 'td_1')).toMatchObject({
      state: 'done',
      doneDate: '2026-10-26',
      source: 'manual',
    });
    expect(await stateOf(pregnancyId, 'td_2')).toMatchObject({
      windowFrom: '2026-11-23',
      state: 'upcoming',
    });
    await run((tx) =>
      markScheduleItem(
        tx,
        actor(),
        { pregnancyId, code: 'nt_scan', status: 'skipped' } as never,
        NOW,
      ),
    );
    expect((await stateOf(pregnancyId, 'nt_scan')).state).toBe('skipped');
    await run((tx) =>
      markScheduleItem(tx, actor(), { pregnancyId, code: 'td_1', status: 'due' } as never, NOW),
    );
    expect((await stateOf(pregnancyId, 'td_1')).state).toBe('due');
    expect(
      await errKey(
        run((tx) =>
          markScheduleItem(
            tx,
            actor(),
            { pregnancyId, code: 'nope', status: 'done' } as never,
            NOW,
          ),
        ),
      ),
    ).toBe('anc.scheduleItemNotFound');
    expect(
      await errKey(
        run((tx) =>
          markScheduleItem(
            tx,
            actor(),
            { pregnancyId, code: 'td_1', status: 'done', doneDate: '2026-10-27' },
            NOW,
          ),
        ),
      ),
    ).toBe('anc.doneDateRange');
  });

  it('a completed lab order ticks its item by itself; a merely ordered one does not', async () => {
    const { patientId, pregnancyId } = await start();
    const v = await fx.visit({ patientId, doctorId: fx.doctorB }, NOW);
    const [hiv] = await fx.t.owner
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, fx.f.facilityId), eq(service.code, 'LAB-HIV')));
    const [tsh] = await fx.t.owner
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, fx.f.facilityId), eq(service.code, 'LAB-TSH')));
    const order = (serviceId: string, status: string) =>
      fx.t.owner.insert(clinicalOrder).values({
        id: uuidv7(),
        facilityId: fx.f.facilityId,
        encounterId: v.encounterId,
        patientId,
        kind: 'lab',
        serviceId,
        status,
        enteredBy: fx.f.userId,
      });
    await order(hiv!.id, 'completed');
    await order(tsh!.id, 'ordered');
    expect(await stateOf(pregnancyId, 'hiv')).toMatchObject({
      state: 'done',
      source: 'order',
      doneDate: '2026-10-26',
    });
    expect((await stateOf(pregnancyId, 'tsh')).state).toBe('due');
  });

  it('suggests the next visit from the last one by the GA interval', async () => {
    const { pregnancyId } = await start();
    await visit(pregnancyId, { visitDate: '2026-10-26' });
    const v = await view(pregnancyId);
    expect(v.nextVisit).toMatchObject({ date: '2026-11-23', intervalDays: 28, overdue: false });
    // Late in pregnancy it is weekly.
    const late = await start({ lmp: '2026-02-01' });
    await run((tx) =>
      saveAncVisit(
        tx,
        actor(),
        { pregnancyId: late.pregnancyId, visitDate: '2026-10-20' } as never,
        NOW,
      ),
    );
    const lv = await view(late.pregnancyId);
    expect(lv.nextVisit).toMatchObject({ date: '2026-10-27', intervalDays: 7 });
  });
});

describe('closing a pregnancy and MTP privacy (docs/11 §3.1, acceptance §5)', () => {
  const close = (pregnancyId: string, over: Record<string, unknown>, a = actor()) =>
    run((tx) =>
      closePregnancy(tx, a, { pregnancyId, outcomeDate: '2026-10-26', ...over } as never, NOW),
    );

  it('a delivery closes the record, ends the alert, and the next pregnancy starts at G2 P1', async () => {
    const { patientId, pregnancyId } = await start({ lmp: '2026-01-25' }); // 274 days
    await visit(pregnancyId, { bpSys: 150, bpDia: 95 });
    expect(await errKey(close(pregnancyId, { outcome: 'delivered' }))).toBe(
      'anc.deliveryOutcomeNeeded',
    );
    await close(pregnancyId, { outcome: 'delivered', obOutcome: 'lscs' });
    const v = await view(pregnancyId);
    expect(v).toMatchObject({ status: 'delivered', active: false, ga: null });
    expect(v.outcome).toMatchObject({ date: '2026-10-26' });
    expect(
      await fx.t.owner
        .select()
        .from(patientAlert)
        .where(and(eq(patientAlert.patientId, patientId), eq(patientAlert.active, true))),
    ).toHaveLength(0);
    // Closed means closed: no more edits.
    expect(await errKey(visit(pregnancyId, { visitDate: '2026-10-26' }))).toBe('anc.notActive');
    expect(await errKey(close(pregnancyId, { outcome: 'aborted' }))).toBe('anc.notActive');

    const next = await start({ lmp: LMP }, patientId);
    const nv = await view(next.pregnancyId);
    expect(nv.gpal).toMatchObject({ g: 2, p: 1, a: 0, l: 1 });
    expect(nv.risks.map((r) => r.code)).toContain('previous_lscs');
    expect(nv.history[0]).toMatchObject({ outcome: 'lscs', gestationWeeks: 39, babiesAlive: 1 });
  });

  it.each(['aborted', 'ectopic', 'lost_to_follow_up', 'transferred'] as const)(
    'closes as %s',
    async (outcome) => {
      const { pregnancyId } = await start();
      await close(pregnancyId, { outcome, outcomeDate: '2026-10-20' });
      expect((await view(pregnancyId)).status).toBe(outcome);
    },
  );

  it('an outcome date must lie within the pregnancy and not in the future', async () => {
    const { pregnancyId } = await start();
    expect(
      await errKey(close(pregnancyId, { outcome: 'aborted', outcomeDate: '2026-10-27' })),
    ).toBe('anc.outcomeDateRange');
    expect(
      await errKey(close(pregnancyId, { outcome: 'aborted', outcomeDate: '2026-06-01' })),
    ).toBe('anc.outcomeDateRange');
  });

  it('MTP: needs the MTP-edit permission, reads as "closed" without MTP-view, and views are access-logged', async () => {
    const { patientId, pregnancyId } = await start();
    expect(await errKey(close(pregnancyId, { outcome: 'mtp', reason: 'x' }))).toBe(
      'anc.mtpForbidden',
    );
    expect((await view(pregnancyId)).status).toBe('active'); // nothing changed

    await close(
      pregnancyId,
      { outcome: 'mtp', reason: 'confidential' },
      actor({ view: true, edit: true }),
    );
    const row = (
      await fx.t.owner.select().from(pregnancy).where(eq(pregnancy.id, pregnancyId))
    )[0]!;
    expect(row.status).toBe('mtp');

    // A user without MTP permission: closed, with no date or reason, in every read path.
    const plain = await view(pregnancyId);
    expect(plain.status).toBe('closed');
    expect(plain.outcome).toBeNull();
    expect(JSON.stringify(plain)).not.toMatch(/mtp|confidential/i);
    const pa = await run((tx) => patientAnc(tx, actor(), patientId, NOW));
    expect(pa.past).toEqual([
      { id: pregnancyId, status: 'closed', outcomeDate: null, eddFinal: '2027-04-26' },
    ]);
    expect(JSON.stringify(pa)).not.toMatch(/mtp|confidential/i);
    expect(
      await fx.t.owner.select().from(accessLog).where(eq(accessLog.entityId, pregnancyId)),
    ).toHaveLength(0);

    // The MTP user sees it, and that read is logged.
    const privileged = await view(pregnancyId, actor({ view: true, edit: false }));
    expect(privileged.status).toBe('mtp');
    expect(privileged.outcome?.reason).toBe('confidential');
    expect(
      await fx.t.owner.select().from(accessLog).where(eq(accessLog.entityId, pregnancyId)),
    ).toHaveLength(1);

    // What the next pregnancy sees is an ordinary abortion in the history: no trace of MTP.
    const next = await start({}, patientId);
    const nv = await view(next.pregnancyId);
    expect(nv.history.map((h) => h.outcome)).toEqual(['abortion']);
    expect(nv.gpal).toMatchObject({ g: 2, a: 1 });
    expect(JSON.stringify(nv)).not.toMatch(/mtp/i);
  });

  it('the active list and summary never show closed pregnancies, and show the active one', async () => {
    const { patientId, pregnancyId } = await start({ lmp: '2026-09-01' });
    const list = await run((tx) => activePregnancies(tx, actor(), NOW));
    expect(list.find((p) => p.id === pregnancyId)).toMatchObject({
      patientId,
      gaLabel: '7w 6d',
      gpalText: 'G1 P0 A0 L0',
    });
    const s = await run((tx) => ancSummary(tx, actor(), patientId, NOW));
    expect(s).toMatchObject({ pregnancyId, gaLabel: '7w 6d' });
    await close(pregnancyId, { outcome: 'aborted', outcomeDate: '2026-10-20' });
    expect(
      (await run((tx) => activePregnancies(tx, actor(), NOW))).find((p) => p.id === pregnancyId),
    ).toBeUndefined();
    expect(await run((tx) => ancSummary(tx, actor(), patientId, NOW))).toBeNull();
  });
});
