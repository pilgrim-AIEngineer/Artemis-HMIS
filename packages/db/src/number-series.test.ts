import { NUMBER_SERIES_CONFIG_SETTING } from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, numberSeries, setting } from '../schema';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { allocateDailyToken, allocateNumber } from './number-series';
import { withTx } from './tx';

let t: PlatformTestDb;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'), 25);
});

afterAll(async () => {
  await t.close();
});

const ctx = (f: SeededFacility) => ({ db: t.app, userId: f.userId, facilityId: f.facilityId });

// IST instants (UTC+05:30)
const OCT_2026 = new Date('2026-10-25T05:00:00Z');
const LAST_SECOND_OF_FY = new Date('2027-03-31T18:29:59Z'); // 31-Mar-2027 23:59:59 IST
const FIRST_SECOND_OF_FY = new Date('2027-03-31T18:30:00Z'); // 01-Apr-2027 00:00:00 IST

describe('allocateNumber (FND-05, docs/02 §4)', () => {
  it('formats never-reset, FY and calendar-year series', async () => {
    const f = await seedFacility(t.owner);
    const got = await withTx(ctx(f), async (tx) => [
      await allocateNumber(tx, f.facilityId, 'uhid', OCT_2026),
      await allocateNumber(tx, f.facilityId, 'uhid', OCT_2026),
      await allocateNumber(tx, f.facilityId, 'opd_visit', OCT_2026),
      await allocateNumber(tx, f.facilityId, 'ipd_admission', OCT_2026),
      await allocateNumber(tx, f.facilityId, 'form_f', OCT_2026),
      await allocateNumber(tx, f.facilityId, 'mtp_register', OCT_2026),
    ]);
    expect(got.map((n) => n.formatted)).toEqual([
      'UH-000001',
      'UH-000002',
      'OP/26-27/000001',
      'IP/26-27/00001',
      'FF/2026/0001',
      'MTP/2026/001',
    ]);
    expect(got.map((n) => n.period)).toEqual(['all', 'all', '2026-27', '2026-27', '2026', '2026']);
  });

  it('gives 50 concurrent allocations 50 distinct, gap-free numbers', async () => {
    const f = await seedFacility(t.owner);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'receipt', OCT_2026)),
      ),
    );
    const values = results.map((r) => r.value).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.formatted)).size).toBe(50);
    const [row] = await t.app
      .select()
      .from(numberSeries)
      .where(and(eq(numberSeries.facilityId, f.facilityId), eq(numberSeries.key, 'receipt')));
    expect(row?.nextValue).toBe(51);
  });

  it('rolls FY series over at 1 April 00:00 IST and never resets UHID', async () => {
    const f = await seedFacility(t.owner);
    const got = await withTx(ctx(f), async (tx) => [
      await allocateNumber(tx, f.facilityId, 'opd_bill', LAST_SECOND_OF_FY),
      await allocateNumber(tx, f.facilityId, 'opd_bill', LAST_SECOND_OF_FY),
      await allocateNumber(tx, f.facilityId, 'opd_bill', FIRST_SECOND_OF_FY),
      // Back-dated entry into the closed FY keeps counting there.
      await allocateNumber(tx, f.facilityId, 'opd_bill', LAST_SECOND_OF_FY),
      await allocateNumber(tx, f.facilityId, 'uhid', LAST_SECOND_OF_FY),
      await allocateNumber(tx, f.facilityId, 'uhid', FIRST_SECOND_OF_FY),
    ]);
    expect(got.map((n) => n.formatted)).toEqual([
      'OB/26-27/000001',
      'OB/26-27/000002',
      'OB/27-28/000001',
      'OB/26-27/000003',
      'UH-000001',
      'UH-000002',
    ]);
  });

  it('rolls calendar-year series over at 1 January IST', async () => {
    const f = await seedFacility(t.owner);
    const got = await withTx(ctx(f), async (tx) => [
      await allocateNumber(tx, f.facilityId, 'birth_register', new Date('2026-12-31T18:29:59Z')),
      await allocateNumber(tx, f.facilityId, 'birth_register', new Date('2026-12-31T18:30:00Z')),
    ]);
    expect(got.map((n) => n.formatted)).toEqual(['BR/2026/0001', 'BR/2027/0001']);
  });

  it('releases the number on rollback: committed numbers stay gap-free', async () => {
    // The counter row is updated inside the business transaction, so a rollback undoes the
    // increment too: docs/02 §4 allows a gap there, but none appears.
    const f = await seedFacility(t.owner);
    const next = () =>
      withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'deposit', OCT_2026));
    expect((await next()).value).toBe(1);
    expect((await next()).value).toBe(2);
    await expect(
      withTx(ctx(f), async (tx) => {
        expect((await allocateNumber(tx, f.facilityId, 'deposit', OCT_2026)).value).toBe(3);
        throw new Error('payment failed');
      }),
    ).rejects.toThrow('payment failed');
    expect((await next()).value).toBe(3);
    expect((await next()).value).toBe(4);
  });

  it('hands a rolled-back number to the transaction waiting on the row lock', async () => {
    const f = await seedFacility(t.owner);
    await withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'ipd_bill', OCT_2026));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstHolds!: () => void;
    const holding = new Promise<void>((r) => (firstHolds = r));
    const first = withTx(ctx(f), async (tx) => {
      const n = await allocateNumber(tx, f.facilityId, 'ipd_bill', OCT_2026);
      firstHolds();
      await gate;
      throw new Error(`rolled back ${n.value}`);
    });
    await holding;
    const second = withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'ipd_bill', OCT_2026));
    await new Promise((r) => setTimeout(r, 100)); // second is now blocked on the row lock
    release();
    await expect(first).rejects.toThrow('rolled back 2');
    expect((await second).formatted).toBe('IB/26-27/00002');
  });

  it('rolls back the period row when the first allocation of a period fails', async () => {
    const f = await seedFacility(t.owner);
    await expect(
      withTx(ctx(f), async (tx) => {
        await allocateNumber(tx, f.facilityId, 'lab_order', OCT_2026);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await t.app
      .select()
      .from(numberSeries)
      .where(and(eq(numberSeries.facilityId, f.facilityId), eq(numberSeries.key, 'lab_order')));
    expect(rows).toHaveLength(0);
    const n = await withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'lab_order', OCT_2026));
    expect(n.formatted).toBe('LB/26-27/000001');
  });

  it('keeps facilities independent', async () => {
    const a = await seedFacility(t.owner, 'A');
    const b = await seedFacility(t.owner, 'B');
    await withTx(ctx(a), (tx) => allocateNumber(tx, a.facilityId, 'opd_visit', OCT_2026));
    const nb = await withTx(ctx(b), (tx) =>
      allocateNumber(tx, b.facilityId, 'opd_visit', OCT_2026),
    );
    expect(nb.value).toBe(1);
  });

  it('uses prefix/padding from the setting and carries an edited prefix into the next FY', async () => {
    const f = await seedFacility(t.owner);
    await withTx(ctx(f), (tx) =>
      tx.insert(setting).values({
        facilityId: f.facilityId,
        key: NUMBER_SERIES_CONFIG_SETTING,
        value: { uhid: { prefix: 'GH' } },
      }),
    );
    const uhid = await withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'uhid', OCT_2026));
    expect(uhid.formatted).toBe('GH-000001');

    await withTx(ctx(f), async (tx) => {
      await allocateNumber(tx, f.facilityId, 'pharmacy_invoice', OCT_2026);
      await tx
        .update(numberSeries)
        .set({ prefix: 'PHX' })
        .where(
          and(eq(numberSeries.facilityId, f.facilityId), eq(numberSeries.key, 'pharmacy_invoice')),
        );
    });
    const next = await withTx(ctx(f), (tx) =>
      allocateNumber(tx, f.facilityId, 'pharmacy_invoice', FIRST_SECOND_OF_FY),
    );
    expect(next.formatted).toBe('PHX/27-28/000001');
  });

  it('audits allocations with the acting user', async () => {
    const f = await seedFacility(t.owner);
    await withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'credit_note', OCT_2026));
    await withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'credit_note', OCT_2026));
    const [row] = await t.app
      .select({ id: numberSeries.id })
      .from(numberSeries)
      .where(and(eq(numberSeries.facilityId, f.facilityId), eq(numberSeries.key, 'credit_note')));
    const audit = await t.app
      .select({ action: auditLog.action, changedBy: auditLog.changedBy })
      .from(auditLog)
      .where(eq(auditLog.rowId, row!.id));
    // Insert + first bump share a transaction (same changed_at), so compare as a multiset.
    expect(audit.map((a) => a.action).sort()).toEqual(['I', 'U', 'U']);
    expect(new Set(audit.map((a) => a.changedBy))).toEqual(new Set([f.userId]));
  });

  it('rejects unknown keys and bad facility ids', async () => {
    const f = await seedFacility(t.owner);
    await expect(
      withTx(ctx(f), (tx) => allocateNumber(tx, f.facilityId, 'token' as never, OCT_2026)),
    ).rejects.toThrow();
    await expect(
      withTx(ctx(f), (tx) => allocateNumber(tx, 'nope', 'uhid', OCT_2026)),
    ).rejects.toThrow();
  });
});

describe('allocateDailyToken (REG-04 helper)', () => {
  // Stand-in for opd_token (REG-04) with the same uniqueness rule.
  beforeAll(async () => {
    await t.owner.$client.query(`
      create table test_opd_token (
        id uuid primary key,
        doctor_id uuid not null,
        token_date date not null,
        token_no int not null,
        unique (doctor_id, token_date, token_no)
      );
      grant select, insert on test_opd_token to hmis_app;
    `);
  });

  const issue = (f: SeededFacility, doctorId: string, at: Date) =>
    withTx(ctx(f), async (tx) => {
      const token = await allocateDailyToken(tx, {
        facilityId: f.facilityId,
        doctorId,
        at,
        currentMax: async (q, tokenDate) => {
          const r = await q.execute<{ max: number | null }>(
            sql`select max(token_no) as max from test_opd_token
                where doctor_id = ${doctorId} and token_date = ${tokenDate}`,
          );
          return r.rows[0]?.max ?? null;
        },
      });
      await tx.execute(
        sql`insert into test_opd_token values (${uuidv7()}, ${doctorId}, ${token.tokenDate}, ${token.tokenNo})`,
      );
      return token;
    });

  it('issues 1..n per doctor per day under concurrency', async () => {
    const f = await seedFacility(t.owner);
    const doctors = [uuidv7(), uuidv7()];
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => issue(f, doctors[i % 2]!, OCT_2026)),
    );
    for (const d of [0, 1]) {
      const mine = results
        .filter((_, i) => i % 2 === d)
        .map((r) => r.tokenNo)
        .sort((a, b) => a - b);
      expect(mine).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    }
    expect(new Set(results.map((r) => r.tokenDate))).toEqual(new Set(['2026-10-25']));
  });

  it('restarts at 1 on the next IST day', async () => {
    const f = await seedFacility(t.owner);
    const doctor = uuidv7();
    expect((await issue(f, doctor, new Date('2026-10-25T18:29:00Z'))).tokenNo).toBe(1);
    expect((await issue(f, doctor, new Date('2026-10-25T18:29:30Z'))).tokenNo).toBe(2);
    const nextDay = await issue(f, doctor, new Date('2026-10-25T18:30:00Z'));
    expect(nextDay).toEqual({ tokenDate: '2026-10-26', tokenNo: 1 });
  });

  it('refuses to run under REPEATABLE READ', async () => {
    const f = await seedFacility(t.owner);
    await expect(
      withTx(
        ctx(f),
        (tx) =>
          allocateDailyToken(tx, {
            facilityId: f.facilityId,
            doctorId: uuidv7(),
            at: OCT_2026,
            currentMax: () => Promise.resolve(null),
          }),
        { isolationLevel: 'repeatable read' },
      ),
    ).rejects.toThrow(/READ COMMITTED/);
  });
});
