import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addBillLineSchema,
  billHeaderTotals,
  billInvariantHolds,
  cashChange,
  checkTenders,
  collectPaymentSchema,
  maskRef,
  upiRefNeeded,
  type StoredLine,
  type Tender,
} from './billing';
import { getSettingDefault } from './settings';

const KEY = '0190f5a0-0000-7000-8000-000000000001';
const BILL = '0190f5a0-0000-7000-8000-000000000002';

const line = (over: Partial<StoredLine> = {}): StoredLine => ({
  unitRatePaise: 50_000n,
  qty: '1',
  discountPaise: 0n,
  gstRateBp: 0,
  isExempt: true,
  sacHsn: '999312',
  ...over,
});

describe('bill totals (docs/04 §15.1, docs/02 §2)', () => {
  it('sums an exempt consultation exactly with no round-off', () => {
    const t = billHeaderTotals([line()], { roundToRupee: true });
    expect(t).toMatchObject({
      grossPaise: 50_000n,
      taxablePaise: 50_000n,
      cgstPaise: 0n,
      sgstPaise: 0n,
      roundOffPaise: 0n,
      netPaise: 50_000n,
      patientSharePaise: 50_000n,
      payerSharePaise: 0n,
    });
  });

  it('rounds the bill (not the lines) to the nearest rupee, 50 paise away from zero', () => {
    const t = billHeaderTotals([line({ unitRatePaise: 33_350n }), line({ unitRatePaise: 100n })], {
      roundToRupee: true,
    });
    expect(t.grossPaise).toBe(33_450n);
    expect(t.roundOffPaise).toBe(50n);
    expect(t.netPaise).toBe(33_500n);
    const down = billHeaderTotals([line({ unitRatePaise: 33_349n })], { roundToRupee: true });
    expect([down.roundOffPaise, down.netPaise]).toEqual([-49n, 33_300n]);
    const off = billHeaderTotals([line({ unitRatePaise: 33_349n })], { roundToRupee: false });
    expect([off.roundOffPaise, off.netPaise]).toEqual([0n, 33_349n]);
  });

  it('charges GST per line, split equally between CGST and SGST', () => {
    // Taxable item ₹199.99 × 3 at 5%: taxable 59,997 paise; half of 5% = 1,499.925 → 1,500 each.
    const t = billHeaderTotals(
      [
        line({ unitRatePaise: 19_999n, qty: '3', gstRateBp: 500, isExempt: false }),
        line({ unitRatePaise: 40_000n }),
      ],
      { roundToRupee: true },
    );
    expect(t.computed.lines[0]).toMatchObject({ cgstPaise: 1_500n, sgstPaise: 1_500n });
    expect(t.cgstPaise).toBe(1_500n);
    expect(t.sgstPaise).toBe(1_500n);
    expect(t.grossPaise).toBe(99_997n);
    expect(t.netPaise).toBe(103_000n); // 1,02,997 + 3 paise round-off
    expect(t.computed.hsnSummary).toHaveLength(1);
  });

  it('ignores the GST rate of an exempt line and rounds fractional quantities per line', () => {
    const t = billHeaderTotals(
      [line({ unitRatePaise: 10_001n, qty: '1.5', gstRateBp: 1800, isExempt: true })],
      { roundToRupee: false },
    );
    expect(t.grossPaise).toBe(15_002n); // 15,001.5 → half away from zero
    expect(t.cgstPaise + t.sgstPaise).toBe(0n);
  });

  it('holds the invariant for any lines (property)', () => {
    const arbLine = fc.record({
      unitRatePaise: fc.bigInt({ min: 0n, max: 10_000_000n }),
      qtyMilli: fc.integer({ min: 1, max: 20_000 }),
      gstRateBp: fc.constantFrom(0, 500, 1200, 1800, 2800),
      isExempt: fc.boolean(),
      discountPct: fc.integer({ min: 0, max: 100 }),
    });
    fc.assert(
      fc.property(fc.array(arbLine, { maxLength: 15 }), fc.boolean(), (raw, round) => {
        const lines = raw.map((r) => {
          const qty = `${Math.floor(r.qtyMilli / 1000)}.${String(r.qtyMilli % 1000).padStart(3, '0')}`;
          const gross = (r.unitRatePaise * BigInt(r.qtyMilli) * 2n + 1000n) / 2000n;
          return line({
            unitRatePaise: r.unitRatePaise,
            qty,
            gstRateBp: r.isExempt ? 0 : r.gstRateBp,
            isExempt: r.isExempt,
            discountPaise: (gross * BigInt(r.discountPct)) / 100n,
          });
        });
        const t = billHeaderTotals(lines, { roundToRupee: round });
        expect(billInvariantHolds(t)).toBe(true);
        expect(t.cgstPaise).toBe(t.sgstPaise);
        if (round) {
          expect(t.netPaise % 100n).toBe(0n);
          expect(t.roundOffPaise >= -50n && t.roundOffPaise <= 50n).toBe(true);
        } else expect(t.roundOffPaise).toBe(0n);
      }),
      { numRuns: 500 },
    );
  });

  it('detects a broken header', () => {
    const t = billHeaderTotals([line()], { roundToRupee: true });
    expect(billInvariantHolds({ ...t, netPaise: t.netPaise + 1n })).toBe(false);
    expect(billInvariantHolds({ ...t, patientSharePaise: 0n })).toBe(false);
  });
});

describe('tenders (docs/12 §3)', () => {
  const optional = getSettingDefault('billing.upiRefRequired');
  const above2000 = { mode: 'required_above_amount' as const, abovePaise: 200_000 };
  const cash = (amountPaise: bigint): Tender => ({ mode: 'cash', amountPaise });
  const upi = (amountPaise: bigint, upiRef?: string): Tender => ({
    mode: 'upi',
    amountPaise,
    upiRef,
  });

  it('accepts a full, a partial and a split payment', () => {
    expect(checkTenders(50_000n, [cash(50_000n)], optional)).toEqual({
      ok: true,
      totalPaise: 50_000n,
    });
    expect(checkTenders(50_000n, [cash(20_000n)], optional)).toEqual({
      ok: true,
      totalPaise: 20_000n,
    });
    expect(checkTenders(50_000n, [cash(30_000n), upi(20_000n)], optional)).toEqual({
      ok: true,
      totalPaise: 50_000n,
    });
  });

  it('rejects overpayment by a single paisa and payment of a settled bill', () => {
    expect(checkTenders(50_000n, [cash(50_001n)], optional)).toEqual({
      ok: false,
      error: 'billing.overpayment',
    });
    expect(checkTenders(50_000n, [cash(30_000n), upi(20_001n)], optional)).toMatchObject({
      error: 'billing.overpayment',
    });
    expect(checkTenders(0n, [cash(1n)], optional)).toMatchObject({ error: 'billing.nothingDue' });
  });

  it('applies the UPI reference rule', () => {
    expect(upiRefNeeded(optional, 10_000_000n)).toBe(false);
    expect(upiRefNeeded({ mode: 'off', abovePaise: 0 }, 10_000_000n)).toBe(false);
    expect(upiRefNeeded(above2000, 200_000n)).toBe(false);
    expect(upiRefNeeded(above2000, 200_001n)).toBe(true);
    expect(checkTenders(500_000n, [upi(300_000n)], above2000)).toMatchObject({
      error: 'billing.upiRefRequired',
    });
    expect(checkTenders(500_000n, [upi(300_000n, '4321')], above2000)).toMatchObject({ ok: true });
  });

  it('computes change to return from cash tendered', () => {
    expect(cashChange(50_000n, 30_000n)).toBe(20_000n);
    expect(cashChange(30_000n, 30_000n)).toBe(0n);
    expect(cashChange(29_999n, 30_000n)).toBeNull();
  });

  it('masks references to the last digits', () => {
    expect(maskRef('123456789012')).toBe('…9012');
    expect(maskRef('4321')).toBe('4321');
    expect(maskRef(null)).toBeNull();
  });
});

describe('billing inputs', () => {
  it('requires one tender per mode, positive amounts and well-formed references', () => {
    const ok = collectPaymentSchema.parse({
      billId: BILL,
      idempotencyKey: KEY,
      tenders: [
        { mode: 'cash', amountPaise: '30000' },
        { mode: 'upi', amountPaise: 20_000, upiRef: ' 123456 ', upiPayerName: '' },
      ],
    });
    expect(ok.tenders[0]?.amountPaise).toBe(30_000n);
    expect(ok.tenders[1]).toMatchObject({ upiRef: '123456', upiPayerName: undefined });
    const bad = (tenders: unknown[]) =>
      collectPaymentSchema.safeParse({ billId: BILL, idempotencyKey: KEY, tenders }).success;
    expect(
      bad([
        { mode: 'cash', amountPaise: 1 },
        { mode: 'cash', amountPaise: 2 },
      ]),
    ).toBe(false);
    expect(bad([])).toBe(false);
    expect(bad([{ mode: 'cash', amountPaise: 0 }])).toBe(false);
    expect(bad([{ mode: 'cash', amountPaise: -5 }])).toBe(false);
    expect(bad([{ mode: 'cash', amountPaise: 1.5 }])).toBe(false);
    expect(bad([{ mode: 'cash', amountPaise: '1000000000001' }])).toBe(false);
    expect(bad([{ mode: 'upi', amountPaise: 1, upiRef: '12ab' }])).toBe(false);
    expect(bad([{ mode: 'card', amountPaise: 1, cardLast4: '123' }])).toBe(false);
    expect(bad([{ mode: 'cheque', amountPaise: 1 }])).toBe(false);
    expect(
      collectPaymentSchema.safeParse({
        billId: BILL,
        idempotencyKey: 'x',
        tenders: [{ mode: 'cash', amountPaise: 1 }],
      }).success,
    ).toBe(false);
  });

  it('defaults a line to one unit and caps the quantity', () => {
    expect(
      addBillLineSchema.parse({ billId: BILL, serviceId: BILL, idempotencyKey: KEY }).qty,
    ).toBe('1');
    expect(
      addBillLineSchema.safeParse({
        billId: BILL,
        serviceId: BILL,
        idempotencyKey: KEY,
        qty: '1000',
      }).success,
    ).toBe(false);
  });
});
