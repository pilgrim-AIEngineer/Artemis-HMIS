import { findForbiddenTerms, rupeesToPaise, SERIES_KEYS } from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  auditLog,
  department,
  drug,
  labTest,
  numberSeries,
  payer,
  reasonCode,
  service,
  serviceRate,
  tariff,
  usgProcedure,
} from '../schema';
import { seedDemoData } from '../seed/demo';
import { createRng } from '../seed/demo/rng';
import { indianMobile, indianName } from '../seed/demo/people';
import { DEPARTMENTS } from '../seed/data/departments';
import { LAB_TESTS } from '../seed/data/lab-tests';
import { SERVICES } from '../seed/data/services';
import { STARTER_DRUGS } from '../seed/data/drugs';
import { USG_PROCEDURES } from '../seed/data/usg';
import { REASON_CODES } from '../seed/data/reasons';
import { seedMasters, type MasterSeedResult } from '../seed/masters';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { getRate, MasterRefError, pickTariff, setServiceRate } from './masters';
import { withTx } from './tx';

let t: PlatformTestDb;
let f: SeededFacility;
let m: MasterSeedResult;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
  f = await seedFacility(t.owner);
  m = await withTx({ db: t.app, userId: f.userId, facilityId: f.facilityId }, (tx) =>
    seedMasters(tx, f.facilityId, new Date('2026-10-26T05:00:00Z')),
  );
});

afterAll(async () => {
  await t.close();
});

const ctx = () => ({ db: t.app, userId: f.userId, facilityId: f.facilityId });
const svcId = async (code: string) =>
  (
    await t.app
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, code)))
  )[0]!.id;
const rupees = (n: number) => rupeesToPaise(n);
/** Drizzle wraps driver errors; the constraint name lives on `cause`. */
const dbError = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    const e = err as { message: string; cause?: { message?: string } };
    return `${e.message} ${e.cause?.message ?? ''}`;
  }
  throw new Error('expected the statement to fail');
};

describe('master seeds (docs/33)', () => {
  it('loads departments, one Cash payer, the Standard tariff and reason codes', async () => {
    const depts = await t.app
      .select()
      .from(department)
      .where(eq(department.facilityId, f.facilityId));
    expect(depts.map((d) => d.code).sort()).toEqual(DEPARTMENTS.map((d) => d.code).sort());
    expect(depts.find((d) => d.code === 'CARD')?.isActive).toBe(false);
    expect(depts.filter((d) => d.isActive)).toHaveLength(DEPARTMENTS.length - 1);

    const payers = await t.app.select().from(payer).where(eq(payer.facilityId, f.facilityId));
    expect(payers).toHaveLength(1);
    expect(payers[0]).toMatchObject({ name: 'Cash / Self', type: 'self', isActive: true });

    const tariffs = await t.app.select().from(tariff).where(eq(tariff.facilityId, f.facilityId));
    expect(tariffs).toHaveLength(1);
    expect(tariffs[0]).toMatchObject({ name: 'Standard (Cash)', payerId: null, isActive: true });

    const reasons = await t.app
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.facilityId, f.facilityId));
    expect(reasons).toHaveLength(REASON_CODES.length);
    expect(reasons.filter((r) => r.kind === 'discount').map((r) => r.code)).toEqual(
      expect.arrayContaining([
        'staff',
        'doctor_discretion',
        'poor_patient',
        'follow_up_concession',
      ]),
    );
  });

  it('seeds service names with no rates, plus one service per USG procedure and lab test', async () => {
    const services = await t.app.select().from(service).where(eq(service.facilityId, f.facilityId));
    expect(services).toHaveLength(SERVICES.length + USG_PROCEDURES.length + LAB_TESTS.length);
    expect(services.every((s) => s.isExempt && s.defaultGstRateBp === 0)).toBe(true);
    const rates = await t.app
      .select()
      .from(serviceRate)
      .where(eq(serviceRate.facilityId, f.facilityId));
    expect(rates).toHaveLength(0);

    const usg = await t.app
      .select()
      .from(usgProcedure)
      .where(eq(usgProcedure.facilityId, f.facilityId));
    expect(usg).toHaveLength(USG_PROCEDURES.length);
    const linkedUsg = services.filter((s) => s.linkedUsgProcedureId);
    expect(new Set(linkedUsg.map((s) => s.linkedUsgProcedureId))).toEqual(
      new Set(usg.map((u) => u.id)),
    );
    // Legal safe default: only the neonatal scan skips Form F gating.
    expect(usg.filter((u) => !u.requiresFormFIfPregnant).map((u) => u.code)).toEqual([
      'NEO-CRANIAL',
    ]);

    const labs = await t.app.select().from(labTest).where(eq(labTest.facilityId, f.facilityId));
    expect(labs).toHaveLength(LAB_TESTS.length);
    for (const l of labs) {
      const s = services.find((x) => x.id === l.serviceId);
      expect(s?.linkedLabTestId, l.code).toBe(l.id);
    }
  });

  it('seeds the starter drug list without guessing legal schedules or tax', async () => {
    const drugs = await t.app.select().from(drug).where(eq(drug.facilityId, f.facilityId));
    expect(drugs).toHaveLength(STARTER_DRUGS.length);
    expect(
      drugs.every((d) => d.schedule === 'none' && d.gstRateBp === 0 && d.hsnCode === null),
    ).toBe(true);
  });

  it('creates every number series for the current FY (IST) and calendar-year registers', async () => {
    const rows = await t.app
      .select()
      .from(numberSeries)
      .where(eq(numberSeries.facilityId, f.facilityId));
    expect(rows.map((r) => r.key).sort()).toEqual([...SERIES_KEYS].sort());
    expect(rows.find((r) => r.key === 'opd_bill')).toMatchObject({ fy: '2026-27', nextValue: 1 });
    expect(rows.find((r) => r.key === 'uhid')?.fy).toBe('all');
  });

  it('is idempotent and never overwrites what the hospital edited', async () => {
    await withTx(ctx(), (tx) =>
      tx.update(department).set({ name: 'Women & Child Health' }).where(eq(department.code, 'GYN')),
    );
    const again = await withTx(ctx(), (tx) => seedMasters(tx, f.facilityId));
    expect(Object.values(again.inserted).every((n) => n === 0)).toBe(true);
    expect(again.defaultTariffId).toBe(m.defaultTariffId);
    const [gyn] = await t.app.select().from(department).where(eq(department.code, 'GYN'));
    expect(gyn?.name).toBe('Women & Child Health');
  });

  it('seeds a second facility independently (codes are unique per facility)', async () => {
    const other = await seedFacility(t.owner, 'Second Hospital');
    const res = await withTx(
      { db: t.app, userId: other.userId, facilityId: other.facilityId },
      (tx) => seedMasters(tx, other.facilityId),
    );
    expect(res.inserted.department).toBe(DEPARTMENTS.length);
    expect(res.defaultTariffId).not.toBe(m.defaultTariffId);
  });

  it('never carries forbidden PCPNDT terms (AGENTS.md rule 7)', () => {
    const texts = [
      ...DEPARTMENTS.flatMap((d) => [d.name, d.nameHi]),
      ...SERVICES.flatMap((s) => [s.name, s.nameHi]),
      ...USG_PROCEDURES.flatMap((u) => [u.name, u.nameHi, u.code]),
      ...LAB_TESTS.map((l) => l.name),
      ...STARTER_DRUGS.map((d) => d.name),
      ...REASON_CODES.flatMap((r) => [r.label, r.labelHi]),
    ];
    for (const text of texts)
      expect(findForbiddenTerms(text, { tier: 'strict' }), text).toEqual([]);
  });
});

describe('soft cancel and audit (AGENTS.md rules 4–5)', () => {
  it('requires reason and time together with status = cancelled', async () => {
    const id = await svcId('PROC-PAP');
    expect(
      await dbError(
        withTx(ctx(), (tx) =>
          tx.update(service).set({ status: 'cancelled' }).where(eq(service.id, id)),
        ),
      ),
    ).toMatch(/service_cancel_fields/);
    await withTx(ctx(), (tx) =>
      tx
        .update(service)
        .set({
          status: 'cancelled',
          cancelReason: 'Not offered',
          cancelledAt: sql`now()`,
          cancelledBy: f.userId,
        })
        .where(eq(service.id, id)),
    );
    const [row] = await t.app.select().from(service).where(eq(service.id, id));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'Not offered' });
  });

  it('refuses hard deletes for the app role', async () => {
    const id = await svcId('CONS-GYN-NEW');
    expect(
      await dbError(withTx(ctx(), (tx) => tx.delete(service).where(eq(service.id, id)))),
    ).toMatch(/permission denied/);
  });

  it('audits master edits with actor, before and after', async () => {
    const id = await svcId('PROC-NEB');
    await withTx(ctx(), (tx) =>
      tx.update(service).set({ name: 'Nebulisation (per sitting)' }).where(eq(service.id, id)),
    );
    const rows = await t.app
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'service'), eq(auditLog.rowId, id)))
      .orderBy(auditLog.changedAt, auditLog.id);
    expect(rows.map((r) => r.action)).toEqual(['I', 'U']);
    expect(rows[1]).toMatchObject({
      changedBy: f.userId,
      before: { name: 'Nebulisation' },
      after: { name: 'Nebulisation (per sitting)' },
    });
  });

  it('keeps GST consistent: exempt services cannot carry a rate', async () => {
    const id = await svcId('PROC-INJ');
    expect(
      await dbError(
        withTx(ctx(), (tx) =>
          tx.update(service).set({ defaultGstRateBp: 500 }).where(eq(service.id, id)),
        ),
      ),
    ).toMatch(/service_exempt_no_gst/);
  });
});

describe('search_text (trigram search)', () => {
  const search = async (q: string) =>
    (
      await t.owner.$client.query<{ code: string }>(
        `select code from service where facility_id = $1 and (search_text ilike '%' || $2 || '%' or $2 <% search_text) order by word_similarity($2, search_text) desc, code limit 5`,
        [f.facilityId, q],
      )
    ).rows.map((r) => r.code);

  it('is generated from names, Hindi names, codes and short codes', async () => {
    expect(await search('nst')).toContain('PROC-NST');
    expect(await search('cons-anc')).toContain('CONS-ANC');
    expect(await search('कोल्पोस्कोपी')).toContain('PROC-COLPO');
  });

  it('tolerates a typo through trigram similarity', async () => {
    expect(await search('colposcpy')).toContain('PROC-COLPO');
  });

  it('is served by the GIN index on large tables', async () => {
    await t.owner.$client.query('set enable_seqscan = off');
    const { rows } = await t.owner.$client.query<{ 'QUERY PLAN': string }>(
      `explain select 1 from drug where search_text ilike '%para%'`,
    );
    await t.owner.$client.query('reset enable_seqscan');
    expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/drug_search_trgm/);
  });
});

describe('rates and tariffs (docs/12 §1)', () => {
  it('stores paise and resolves the rate in force on a date', async () => {
    const serviceId = await svcId('CONS-GYN-NEW');
    const base = { facilityId: f.facilityId, serviceId, tariffId: m.defaultTariffId };
    const first = await withTx(ctx(), (tx) =>
      setServiceRate(tx, { ...base, ratePaise: rupees(500), effectiveFrom: '2026-04-01' }),
    );
    expect(first.changed).toBe(true);
    // A price rise from 1 Nov is a new row; October bills keep the old price.
    await withTx(ctx(), (tx) =>
      setServiceRate(tx, { ...base, ratePaise: rupees(600), effectiveFrom: '2026-11-01' }),
    );
    const on = (d: string) => getRate(t.app, { ...base, on: d });
    expect((await on('2026-10-31'))?.ratePaise).toBe(50000n);
    expect((await on('2026-11-01'))?.ratePaise).toBe(60000n);
    expect(await on('2026-03-31')).toBeNull();
  });

  it('is a no-op for an identical re-entry and cancels the old row on a same-day correction', async () => {
    const serviceId = await svcId('CONS-ANC');
    const base = {
      facilityId: f.facilityId,
      serviceId,
      tariffId: m.defaultTariffId,
      effectiveFrom: '2026-04-01',
    };
    const a = await withTx(ctx(), (tx) => setServiceRate(tx, { ...base, ratePaise: rupees(400) }));
    const same = await withTx(ctx(), (tx) =>
      setServiceRate(tx, { ...base, ratePaise: rupees(400) }),
    );
    expect(same).toEqual({ changed: false, id: a.id });
    const fixed = await withTx(ctx(), (tx) =>
      setServiceRate(tx, { ...base, ratePaise: rupees(450) }),
    );
    expect(fixed).toMatchObject({ changed: true, replacedId: a.id });
    const rows = await t.app.select().from(serviceRate).where(eq(serviceRate.serviceId, serviceId));
    expect(rows.map((r) => [r.status, r.ratePaise])).toEqual(
      expect.arrayContaining([
        ['cancelled', 40000n],
        ['active', 45000n],
      ]),
    );
    expect(rows.find((r) => r.status === 'cancelled')?.cancelReason).toBeTruthy();
    expect((await getRate(t.app, { ...base, on: '2026-10-26' }))?.ratePaise).toBe(45000n);
  });

  it('prefers a room-specific rate and falls back to the room-agnostic one', async () => {
    const serviceId = await svcId('BED-DAY');
    const room = uuidv7();
    const base = {
      facilityId: f.facilityId,
      serviceId,
      tariffId: m.defaultTariffId,
      effectiveFrom: '2026-04-01',
    };
    await withTx(ctx(), async (tx) => {
      await setServiceRate(tx, { ...base, ratePaise: rupees(1000) });
      await setServiceRate(tx, { ...base, roomCategoryId: room, ratePaise: rupees(2500) });
    });
    const q = {
      facilityId: f.facilityId,
      serviceId,
      tariffId: m.defaultTariffId,
      on: '2026-10-26',
    };
    expect((await getRate(t.app, { ...q, roomCategoryId: room }))?.ratePaise).toBe(250000n);
    expect((await getRate(t.app, { ...q, roomCategoryId: uuidv7() }))?.ratePaise).toBe(100000n);
    expect((await getRate(t.app, q))?.ratePaise).toBe(100000n);
  });

  it('refuses negative rates at the database and cancelled services/tariffs in the helper', async () => {
    const serviceId = await svcId('PROC-DRESS-S');
    const cancelledId = await svcId('PROC-PAP'); // cancelled in the soft-cancel test above
    expect(
      await dbError(
        withTx(ctx(), (tx) =>
          setServiceRate(tx, {
            facilityId: f.facilityId,
            serviceId,
            tariffId: m.defaultTariffId,
            ratePaise: -1n,
            effectiveFrom: '2026-04-01',
          }),
        ),
      ),
    ).toMatch(/service_rate_nonnegative/);
    await expect(
      withTx(ctx(), (tx) =>
        setServiceRate(tx, {
          facilityId: f.facilityId,
          serviceId: cancelledId,
          tariffId: m.defaultTariffId,
          ratePaise: 1n,
          effectiveFrom: '2026-04-01',
        }),
      ),
    ).rejects.toBeInstanceOf(MasterRefError);
  });

  it('picks the payer tariff when it is valid and the default tariff otherwise', async () => {
    const corp = uuidv7();
    const corpTariff = uuidv7();
    await withTx(ctx(), async (tx) => {
      await tx.insert(payer).values({
        id: corp,
        facilityId: f.facilityId,
        name: 'Acme Corporate',
        code: 'ACME',
        type: 'corporate',
        isActive: false,
      });
      await tx.insert(tariff).values({
        id: corpTariff,
        facilityId: f.facilityId,
        name: 'Acme',
        payerId: corp,
        effectiveFrom: '2026-04-01',
      });
    });
    const q = { facilityId: f.facilityId, on: '2026-10-26' };
    // Inactive payer: its tariff is ignored.
    expect(await pickTariff(t.app, { ...q, payerId: corp })).toBe(m.defaultTariffId);
    await withTx(ctx(), (tx) => tx.update(payer).set({ isActive: true }).where(eq(payer.id, corp)));
    expect(await pickTariff(t.app, { ...q, payerId: corp })).toBe(corpTariff);
    expect(await pickTariff(t.app, { ...q, payerId: m.selfPayerId })).toBe(m.defaultTariffId);
    expect(await pickTariff(t.app, { ...q, payerId: null })).toBe(m.defaultTariffId);
    // Outside the tariff's validity window the default applies again.
    expect(
      await pickTariff(t.app, { facilityId: f.facilityId, payerId: corp, on: '2026-03-31' }),
    ).toBeNull();
  });
});

describe('demo seed skeleton', () => {
  it('creates demo doctors, rates, patients, 30 days of OPD, 50 pregnancies and 80 children, idempotently', async () => {
    const run = () => withTx(ctx(), (tx) => seedDemoData(tx, f.facilityId, m));
    const first = await run();
    expect(first[0]).toBe('doctors: 3 new demo doctor(s)');
    const second = await run();
    expect(second).toEqual([
      'doctors: 0 new demo doctor(s)',
      'rates: 0 synthetic demo rate(s) in the default tariff',
      'patients: 500 already present',
      expect.stringMatching(/^opd: \d+ visits already present$/),
      'pregnancies: 50 already present',
      'children: 80 already present',
    ]);
    const counts = (
      await t.owner.$client.query<{
        pregnancies: number;
        visits: number;
        children: number;
        doses: number;
      }>(
        `select (select count(*) from pregnancy where facility_id = $1)::int as pregnancies,
                (select count(*) from anc_visit where facility_id = $1)::int as visits,
                (select count(distinct patient_id) from growth_measurement where facility_id = $1)::int as children,
                (select count(*) from immunisation_given where facility_id = $1)::int as doses`,
        [f.facilityId],
      )
    ).rows[0]!;
    expect(counts.pregnancies).toBe(50);
    expect(counts.visits).toBeGreaterThan(100);
    expect(counts.children).toBe(80);
    expect(counts.doses).toBeGreaterThan(200);
    expect(first[3]).toMatch(/^opd: \d+ visits over 30 days$/);
    const opd = (
      await t.owner.$client.query<{ visits: number; tokens: number; open: number; dup: number }>(
        `select (select count(*) from encounter where facility_id = $1)::int as visits,
                (select count(*) from opd_token where facility_id = $1 and queue_state = 'done')::int as tokens,
                (select count(*) from encounter where facility_id = $1 and status <> 'open')::int as open,
                (select count(*) from (select 1 from opd_token where facility_id = $1
                   group by doctor_id, token_date, token_no having count(*) > 1) d)::int as dup`,
        [f.facilityId],
      )
    ).rows[0]!;
    expect(opd.visits).toBeGreaterThan(300);
    expect(opd.tokens).toBe(opd.visits);
    expect(opd).toMatchObject({ open: 0, dup: 0 });
    const rules = (
      await t.owner.$client.query<{ n: number }>(
        `select count(*)::int as n from consultation_rule where facility_id = $1`,
        [f.facilityId],
      )
    ).rows[0]!.n;
    expect(rules).toBe(7);
    // Every demo visit has its bill; priced fees were collected (BIL-02), so those bills are final.
    const bills = (
      await t.owner.$client.query<{ bills: number; final: number; receipts: number }>(
        `select (select count(*) from bill where facility_id = $1)::int as bills,
                (select count(*) from bill where facility_id = $1 and status = 'final')::int as final,
                (select count(distinct number) from payment where facility_id = $1)::int as receipts`,
        [f.facilityId],
      )
    ).rows[0]!;
    expect(bills.bills).toBe(opd.visits);
    expect(bills.final).toBeGreaterThan(0);
    expect(bills.receipts).toBe(bills.final);
    // 30 days of OPD through the real visit, bill and payment code: slow under a parallel run.
  }, 90_000);

  it('generates deterministic Indian names and 9xxxxxxxxx mobiles', () => {
    const a = createRng(7);
    const b = createRng(7);
    expect(indianName(a, 'F')).toEqual(indianName(b, 'F'));
    for (let i = 0; i < 200; i++) expect(indianMobile(a)).toMatch(/^9\d{9}$/);
  });
});
