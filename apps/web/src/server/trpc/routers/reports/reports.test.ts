/**
 * RPT-01 / RPT-02 through tRPC: who may open which report (AGENTS.md rule 6), a doctor seeing only
 * their own OPD counts, input validation that never reaches SQL, and the dashboard agreeing with
 * the collection report. The reconciliation maths is covered in packages/db reports.test.ts.
 */
import { doctorProfile } from '@hmis/db/schema';
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
let reception: TestBrowser;
let cashier: TestBrowser;
let doctor: TestBrowser;
let admin: TestBrowser;
let owner: TestBrowser;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const range = () => ({ from: today(), to: today() });

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  const login = async (u: { username: string }) => {
    const b = f.browser();
    await b.login(u.username);
    return b;
  };
  [reception, cashier, doctor, admin, owner] = await Promise.all([
    login(f.users.reception),
    login(f.users.cashier),
    login(f.users.doctor),
    login(f.users.admin),
    login(f.users.owner),
  ]);
  // The doctor user is doctor A of the facility.
  await f.t.owner
    .update(doctorProfile)
    .set({ userId: f.users.doctor.id })
    .where(eq(doctorProfile.id, opd.doctorA));
});
afterAll(async () => {
  await f.close();
});

async function visit(doctorId: string) {
  return reception.call(async (c) =>
    c.visit.create({ patientId: await opd.newPatient(), doctorId, idempotencyKey: uuidv7() }),
  );
}

describe('permissions (rule 6)', () => {
  it('the front desk and the cashier open no report and no dashboard', async () => {
    for (const b of [reception, cashier]) {
      for (const call of [
        (c: Parameters<Parameters<typeof b.call>[0]>[0]) => c.reports.collection(range()),
        (c: Parameters<Parameters<typeof b.call>[0]>[0]) => c.reports.opdCensus(range()),
        (c: Parameters<Parameters<typeof b.call>[0]>[0]) => c.reports.ancRegister({}),
        (c: Parameters<Parameters<typeof b.call>[0]>[0]) => c.reports.vaccinesDue({}),
        (c: Parameters<Parameters<typeof b.call>[0]>[0]) => c.reports.dashboard(),
        (c: Parameters<Parameters<typeof b.call>[0]>[0]) => c.billing.discountReport(range()),
      ]) {
        expect((await trpcError(b.call(call))).code).toBe('FORBIDDEN');
      }
    }
  });

  it('a doctor gets the clinical reports but not money or the owner dashboard', async () => {
    await expect(doctor.call((c) => c.reports.opdCensus(range()))).resolves.toBeDefined();
    await expect(doctor.call((c) => c.reports.ancRegister({}))).resolves.toBeDefined();
    await expect(doctor.call((c) => c.reports.vaccinesDue({}))).resolves.toBeDefined();
    for (const call of [
      (c: Parameters<Parameters<typeof doctor.call>[0]>[0]) => c.reports.collection(range()),
      (c: Parameters<Parameters<typeof doctor.call>[0]>[0]) => c.reports.dashboard(),
      (c: Parameters<Parameters<typeof doctor.call>[0]>[0]) =>
        c.billing.cancellationReport(range()),
    ]) {
      expect((await trpcError(doctor.call(call))).code).toBe('FORBIDDEN');
    }
  });

  it('admin and owner open everything', async () => {
    for (const b of [admin, owner]) {
      await expect(b.call((c) => c.reports.collection(range()))).resolves.toBeDefined();
      await expect(b.call((c) => c.reports.opdCensus(range()))).resolves.toBeDefined();
      await expect(b.call((c) => c.reports.dashboard())).resolves.toBeDefined();
      await expect(b.call((c) => c.billing.discountReport(range()))).resolves.toBeDefined();
    }
  });
});

describe('a doctor sees only their own OPD counts', () => {
  it('admin sees both doctors; the doctor only doctor A; a doctor without a profile sees nothing', async () => {
    await visit(opd.doctorA);
    await visit(opd.doctorA);
    await visit(opd.doctorB);
    const all = await admin.call((c) => c.reports.opdCensus(range()));
    expect(all.total).toBe(3);
    const own = await doctor.call((c) => c.reports.opdCensus(range()));
    expect(own.total).toBe(2);
    expect(own.rows.map((r) => r.doctorId)).toEqual([opd.doctorA]);
    // Asking for the other doctor's numbers does not widen the view.
    const sneak = await doctor.call((c) =>
      c.reports.opdCensus({ ...range(), doctorId: opd.doctorB }),
    );
    expect(sneak.total).toBe(2);
    await f.t.owner
      .update(doctorProfile)
      .set({ userId: null })
      .where(eq(doctorProfile.id, opd.doctorA));
    expect((await doctor.call((c) => c.reports.opdCensus(range()))).total).toBe(0);
    await f.t.owner
      .update(doctorProfile)
      .set({ userId: f.users.doctor.id })
      .where(eq(doctorProfile.id, opd.doctorA));
  });
});

describe('input validation', () => {
  it('turns a reversed, over-long or impossible date range into a message key, never a 500', async () => {
    const bad = async (input: { from: string; to: string }) => {
      const e = await trpcError(admin.call((c) => c.reports.collection(input)));
      expect(e.code).toBe('BAD_REQUEST');
      return (e.cause as { issues?: { message: string }[] } | undefined)?.issues?.[0]?.message;
    };
    expect(await bad({ from: '2026-10-27', to: '2026-10-26' })).toBe('validation.dateRange');
    expect(await bad({ from: '2024-01-01', to: '2026-10-26' })).toBe('validation.rangeTooLong');
    expect(await bad({ from: '2026-02-31', to: '2026-03-02' })).toBe('validation.date');
    expect(await bad({ from: 'yesterday', to: 'today' })).toBe('validation.date');
    expect(
      (
        await trpcError(
          admin.call((c) => c.billing.discountReport({ from: '2024-01-01', to: '2026-10-26' })),
        )
      ).code,
    ).toBe('BAD_REQUEST');
  });
});

describe('collection and dashboard through the API', () => {
  it('the receipt the cashier takes is in the collection report, the dashboard and the CSV rows', async () => {
    const v = await visit(opd.doctorA);
    await cashier.call((c) =>
      c.billing.collect({
        billId: v.billId,
        tenders: [{ mode: 'cash', amountPaise: 50_000 }] as never,
        idempotencyKey: uuidv7(),
      }),
    );
    const col = await admin.call((c) => c.reports.collection(range()));
    expect(col.total.cashPaise).toBe(50_000n);
    expect(col.total.netPaise).toBe(50_000n);
    expect(col.receipts).toHaveLength(1);
    expect(col.byUser).toHaveLength(1);
    expect(col.byUser[0]!.netPaise).toBe(50_000n);
    const dash = await owner.call((c) => c.reports.dashboard());
    expect(dash.today).toBe(today());
    expect(dash.collectionToday.netPaise).toBe(col.total.netPaise);
    expect(dash.trend.at(-1)!.netPaise).toBe(col.total.netPaise);
    expect(dash.opdToday.total).toBeGreaterThanOrEqual(1);
  });
});
