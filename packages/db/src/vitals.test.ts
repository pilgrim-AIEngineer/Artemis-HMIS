import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, encounter, opdToken, patient, queueEvent, vitals } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { advanceToken, markSeen } from './queue';
import { writeSetting } from './settings';
import { issueToken, VisitInputError } from './visits';
import { activeVitals, recordVitals, vitalsContext, vitalsDesk } from './vitals';

let fx: OpdFixture;
let day = 0;

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

const nextDay = () => {
  day += 1;
  const d = String(day).padStart(2, '0');
  return (hh = '09', mm = '00') => IST(`2028-04-${d}T${hh}:${mm}:00`);
};

async function ticket(
  at: Date,
  opts: {
    dob?: string;
    sex?: string;
    priority?: 'normal' | 'emergency';
    visitType?: 'new' | 'anc';
  } = {},
) {
  const patientId = await fx.newPatient();
  if (opts.dob || opts.sex) {
    await fx.t.owner
      .update(patient)
      .set({ dob: opts.dob ?? '1990-01-01', sex: opts.sex ?? 'F' })
      .where(eq(patient.id, patientId));
  }
  const v = await fx.visit(
    {
      patientId,
      doctorId: fx.doctorB,
      priority: opts.priority ?? 'normal',
      visitType: opts.visitType,
    },
    at,
  );
  const tok = await fx.run((tx) =>
    issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', at),
  );
  return { patientId, encounterId: v.encounterId, tokenId: tok.tokenId };
}

const save = (
  tokenId: string,
  group: 'adult' | 'pregnant' | 'child',
  values: Record<string, unknown>,
  at: Date,
) => fx.run((tx) => recordVitals(tx, fx.actor() as never, { tokenId, group, values }, at));
const tokenOf = async (id: string) =>
  (await fx.t.app.select().from(opdToken).where(eq(opdToken.id, id)))[0]!;
const key = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof VisitInputError ? e.key : String(e)),
  );

describe('saving vitals (OPD-01)', () => {
  it('stores °F as °C, computes BMI, flags, and moves the token to vitals_done once', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    const r = await save(
      t.tokenId,
      'adult',
      { bpSys: 150, bpDia: 95, pulse: 88, tempF: 100.4, spo2: 97, weightKg: 62.5, heightCm: 160 },
      at,
    );
    expect(r).toMatchObject({ advanced: true, printSheet: true, queueState: 'vitals_done' });
    expect(r.flags.map((f) => `${f.code}:${f.level}`)).toEqual([
      'bp_high:amber',
      'temp_high:amber',
    ]);

    const rec = (await activeVitals(fx.t.app, fx.f.facilityId, t.encounterId))!;
    expect(rec).toMatchObject({
      bpSys: 150,
      bpDia: 95,
      pulse: 88,
      tempC: 38,
      tempF: 100.4,
      spo2: 97,
      weightKg: 62.5,
      heightCm: 160,
      bmi: 24.4,
      group: 'adult',
    });
    const tok = await tokenOf(t.tokenId);
    expect(tok.queueState).toBe('vitals_done');
    expect(tok.vitalsAt).toEqual(at);
    const events = await fx.t.app
      .select()
      .from(queueEvent)
      .where(eq(queueEvent.tokenId, t.tokenId));
    expect(events.filter((e) => e.action === 'vitals')).toHaveLength(1);
  });

  it('a correction supersedes the first reading, keeps it on record and does not print again', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    await save(t.tokenId, 'adult', { bpSys: 150, bpDia: 95 }, at);
    const later = new Date(at.getTime() + 60_000);
    const r = await save(t.tokenId, 'adult', { bpSys: 120, bpDia: 80 }, later);
    expect(r).toMatchObject({
      advanced: false,
      printSheet: false,
      queueState: 'vitals_done',
      flags: [],
    });

    const rows = await fx.t.app.select().from(vitals).where(eq(vitals.encounterId, t.encounterId));
    expect(rows.map((x) => [x.bpSys, x.status]).sort()).toEqual([
      [120, 'active'],
      [150, 'superseded'],
    ]);
    expect((await activeVitals(fx.t.app, fx.f.facilityId, t.encounterId))!.bpSys).toBe(120);
  });

  it('does not print when the sheet is set to print at reception', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'opd.sheetPrintAt', 'reception'));
    try {
      expect((await save(t.tokenId, 'adult', { pulse: 80 }, at)).printSheet).toBe(false);
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'opd.sheetPrintAt', 'vitals'));
    }
  });

  it('pregnant form: pregnancy fields stored, raised-BP alert in the flags', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    const r = await save(
      t.tokenId,
      'pregnant',
      {
        bpSys: 146,
        bpDia: 94,
        fundalHeightCm: 28,
        fhr: 144,
        oedema: 'plus1',
        urineAlbumin: 'trace',
        urineSugar: 'nil',
      },
      at,
    );
    expect(r.flags.map((f) => f.code)).toEqual(['bp_high', 'raised_bp_pregnancy']);
    const rec = (await activeVitals(fx.t.app, fx.f.facilityId, t.encounterId))!;
    expect(rec).toMatchObject({
      fundalHeightCm: 28,
      fhr: 144,
      oedema: 'plus1',
      urineAlbumin: 'trace',
    });
  });

  it('child form: head circumference for a baby, weight in two decimals, no BMI', async () => {
    const at = nextDay()();
    const t = await ticket(at, { dob: '2027-08-01', sex: 'M' });
    await save(
      t.tokenId,
      'child',
      { weightKg: 8.45, heightCm: 70.4, headCircCm: 44.1, tempF: 99, spo2: 99, rr: 30 },
      at,
    );
    const rec = (await activeVitals(fx.t.app, fx.f.facilityId, t.encounterId))!;
    expect(rec).toMatchObject({
      weightKg: 8.45,
      headCircCm: 44.1,
      rr: 30,
      bmi: null,
      group: 'child',
    });
  });

  it('refuses a form that does not fit the age, fields the group lacks, and impossible values', async () => {
    const at = nextDay()();
    const kid = await ticket(at, { dob: '2022-01-01', sex: 'M' });
    expect(await key(save(kid.tokenId, 'adult', { pulse: 80 }, at))).toBe('vitals.groupMismatch');
    expect(await key(save(kid.tokenId, 'pregnant', { pulse: 80 }, at))).toBe(
      'vitals.groupMismatch',
    );
    // 6-year-old: head circumference is only asked under 2 years.
    expect(await key(save(kid.tokenId, 'child', { headCircCm: 50 }, at))).toBe('vitals.invalid');
    expect(await key(save(kid.tokenId, 'child', { weightKg: 650 }, at))).toBe('vitals.invalid');
    const man = await ticket(at, { dob: '1980-01-01', sex: 'M' });
    expect(await key(save(man.tokenId, 'pregnant', { pulse: 80 }, at))).toBe(
      'vitals.groupMismatch',
    );
    expect(
      await fx.t.app.select().from(vitals).where(eq(vitals.encounterId, kid.encounterId)),
    ).toHaveLength(0);
  });

  it('works while the patient is with the doctor (late correction) but not after', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    await save(t.tokenId, 'adult', { pulse: 80 }, at);
    await fx.run((tx) => advanceToken(tx, fx.actor(), t.tokenId, 'with_doctor', at));
    expect((await save(t.tokenId, 'adult', { pulse: 82 }, at)).queueState).toBe('with_doctor');
    await fx.run((tx) => markSeen(tx, fx.actor(), t.tokenId, at));
    expect(await key(save(t.tokenId, 'adult', { pulse: 84 }, at))).toBe('vitals.notAllowed');
  });

  it('first reading taken after the patient was called does not move the token back', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    await fx.run((tx) => advanceToken(tx, fx.actor(), t.tokenId, 'with_doctor', at));
    const r = await save(t.tokenId, 'adult', { pulse: 80 }, at);
    expect(r).toMatchObject({ advanced: false, printSheet: false, queueState: 'with_doctor' });
  });

  it('refuses unknown tokens and cancelled visits', async () => {
    const at = nextDay()();
    expect(
      await key(save('0190a000-0000-7000-8000-0000000000aa', 'adult', { pulse: 80 }, at)),
    ).toBe('queue.tokenNotFound');
    const t = await ticket(at);
    await fx.t.owner
      .update(encounter)
      .set({ status: 'cancelled', cancelReason: 'test', cancelledAt: at })
      .where(eq(encounter.id, t.encounterId));
    expect(await key(save(t.tokenId, 'adult', { pulse: 80 }, at))).toBe('vitals.notAllowed');
  });

  it('is audited by the database (insert and the supersede update)', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    await save(t.tokenId, 'adult', { pulse: 80 }, at);
    await save(t.tokenId, 'adult', { pulse: 90 }, at);
    const [row] = await fx.t.owner
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'vitals' and ${auditLog.facilityId} = ${fx.f.facilityId}`);
    expect(row!.n).toBeGreaterThanOrEqual(3);
  });

  it('the database also refuses a second active reading and a bad BP pair', async () => {
    const at = nextDay()();
    const t = await ticket(at);
    await save(t.tokenId, 'adult', { pulse: 80 }, at);
    const base = (
      await fx.t.owner.select().from(vitals).where(eq(vitals.encounterId, t.encounterId))
    )[0]!;
    await expect(
      fx.t.owner.insert(vitals).values({ ...base, id: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(
      fx.t.owner.update(vitals).set({ bpSys: 100, bpDia: 120 }).where(eq(vitals.id, base.id)),
    ).rejects.toThrow();
  });
});

describe('vitals desk list', () => {
  it('lists waiting patients with priority first then oldest, and measured ones apart', async () => {
    const day1 = nextDay();
    const a = await ticket(day1('09', '00'));
    const b = await ticket(day1('09', '05'));
    const c = await ticket(day1('09', '10'), { priority: 'emergency' });
    await save(b.tokenId, 'adult', { bpSys: 170, bpDia: 100 }, day1('09', '12'));
    const desk = await fx.run((tx) => vitalsDesk(tx, fx.f.facilityId, day1('09', '15')));
    expect(desk.waiting.map((i) => i.tokenId)).toEqual([c.tokenId, a.tokenId]);
    expect(desk.done.map((i) => i.tokenId)).toEqual([b.tokenId]);
    expect(desk.done[0]!.flags.map((f) => f.level)).toEqual(['red']);
  });

  it('only shows today', async () => {
    const d = nextDay();
    await ticket(d());
    const other = nextDay();
    expect((await fx.run((tx) => vitalsDesk(tx, fx.f.facilityId, other()))).waiting).toHaveLength(
      0,
    );
  });
});

describe('vitals form context', () => {
  it('suggests the pregnant form for ANC visits and after an earlier pregnant reading', async () => {
    const d = nextDay();
    const anc = await ticket(d(), { visitType: 'anc' });
    const c1 = await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, anc.tokenId, d()));
    expect(c1).toMatchObject({ defaultGroup: 'pregnant', pregnantHint: true });
    expect(c1.allowedGroups).toEqual(['adult', 'pregnant']);

    const plain = await ticket(d());
    expect(
      (await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, plain.tokenId, d()))).defaultGroup,
    ).toBe('adult');
    await save(plain.tokenId, 'pregnant', { pulse: 80 }, d());
    // The next visit of the same patient (a month later) starts on the pregnant form.
    const later = IST('2028-06-20T09:00:00');
    const v2 = await fx.visit({ patientId: plain.patientId, doctorId: fx.doctorB }, later);
    const t2 = await fx.run((tx) =>
      issueToken(tx, fx.actor(), v2.encounterId, 'manual_fee_pending', later),
    );
    expect(
      (await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, t2.tokenId, later))).defaultGroup,
    ).toBe('pregnant');
  });

  it('asks for height when it was never taken or is a year old, and offers the last one', async () => {
    const d = nextDay();
    const first = await ticket(d());
    const c1 = await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, first.tokenId, d()));
    expect(c1).toMatchObject({ heightDue: true, lastHeight: null });

    await save(first.tokenId, 'adult', { heightCm: 158, weightKg: 55 }, d());
    const soon = IST('2028-05-30T09:00:00');
    const v2 = await fx.visit({ patientId: first.patientId, doctorId: fx.doctorB }, soon);
    const t2 = await fx.run((tx) =>
      issueToken(tx, fx.actor(), v2.encounterId, 'manual_fee_pending', soon),
    );
    const c2 = await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, t2.tokenId, soon));
    expect(c2.heightDue).toBe(false);
    expect(c2.lastHeight?.cm).toBe(158);

    const nextYear = IST('2029-06-20T09:00:00');
    const v3 = await fx.visit({ patientId: first.patientId, doctorId: fx.doctorB }, nextYear);
    const t3 = await fx.run((tx) =>
      issueToken(tx, fx.actor(), v3.encounterId, 'manual_fee_pending', nextYear),
    );
    expect(
      (await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, t3.tokenId, nextYear))).heightDue,
    ).toBe(true);
  });

  it('returns the saved reading for a correction and a closed flag once seen', async () => {
    const d = nextDay();
    const t = await ticket(d());
    await save(t.tokenId, 'adult', { pulse: 71, tempF: 98.6 }, d());
    const c = await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, t.tokenId, d()));
    expect(c.current).toMatchObject({ pulse: 71, tempF: 98.6, group: 'adult' });
    expect(c.token.open).toBe(true);
    await fx.run((tx) => markSeen(tx, fx.actor(), t.tokenId, d()));
    expect(
      (await fx.run((tx) => vitalsContext(tx, fx.f.facilityId, t.tokenId, d()))).token.open,
    ).toBe(false);
  });

  it('reports a missing token', async () => {
    expect(
      await key(
        fx.run((tx) =>
          vitalsContext(
            tx,
            fx.f.facilityId,
            '0190a000-0000-7000-8000-0000000000bb',
            IST('2028-04-01T09:00:00'),
          ),
        ),
      ),
    ).toBe('queue.tokenNotFound');
  });
});
