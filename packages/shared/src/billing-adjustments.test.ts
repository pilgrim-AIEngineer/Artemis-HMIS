import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS } from './compliance/forbidden-terms';
import {
  allocateDiscounts,
  applyDiscountSchema,
  cancelBillSchema,
  creditableOf,
  discountWithinLimit,
  needsApprovalAbove,
  refundDue,
  resolveDiscount,
  splitCredit,
} from './billing-adjustments';
import { effectiveDiscountLimit, getSettingDefault } from './settings';

const id = '0198c5e0-0000-7000-8000-000000000001';
const key = '0198c5e0-0000-7000-8000-000000000002';

describe('discountWithinLimit (docs/03 §4)', () => {
  const cashier = { maxPercentBp: 1000, maxAmountPaise: 50_000 };

  it('is the lower of 10% and ₹500', () => {
    expect(discountWithinLimit(cashier, 5_000n, 50_000n)).toBe(true); // exactly 10%
    expect(discountWithinLimit(cashier, 5_001n, 50_000n)).toBe(false);
    expect(discountWithinLimit(cashier, 50_000n, 1_000_000n)).toBe(true); // 5%, exactly ₹500
    expect(discountWithinLimit(cashier, 50_001n, 1_000_000n)).toBe(false); // 5% but over ₹500
  });

  it('allows nothing for a zero limit and everything for null', () => {
    expect(discountWithinLimit({ maxPercentBp: 0, maxAmountPaise: 0 }, 1n, 50_000n)).toBe(false);
    expect(discountWithinLimit({ maxPercentBp: 0, maxAmountPaise: 0 }, 0n, 50_000n)).toBe(true);
    expect(
      discountWithinLimit({ maxPercentBp: null, maxAmountPaise: null }, 50_000n, 50_000n),
    ).toBe(true);
    expect(discountWithinLimit({ maxPercentBp: null, maxAmountPaise: 100 }, 101n, 50_000n)).toBe(
      false,
    );
  });

  it('matches the default settings per role', () => {
    const limits = getSettingDefault('billing.discountLimits');
    const rec = effectiveDiscountLimit(limits, ['reception']);
    expect(discountWithinLimit(rec, 1n, 50_000n)).toBe(false);
    expect(discountWithinLimit(effectiveDiscountLimit(limits, ['owner']), 50_000n, 50_000n)).toBe(
      true,
    );
  });

  it('never approves above the percent, whatever the amounts (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (d, gross, bp) => {
          const ok = discountWithinLimit({ maxPercentBp: bp, maxAmountPaise: null }, d, gross);
          expect(ok).toBe(d * 10_000n <= BigInt(bp) * gross);
        },
      ),
    );
  });
});

describe('resolveDiscount', () => {
  it('rounds a percent to paise and never exceeds the base', () => {
    expect(resolveDiscount({ mode: 'percent', percentBp: 1000 }, 33_350n)).toBe(3_335n);
    expect(resolveDiscount({ mode: 'percent', percentBp: 10_000 }, 33_350n)).toBe(33_350n);
    expect(resolveDiscount({ mode: 'amount', amountPaise: 99_999n }, 33_350n)).toBe(33_350n);
  });
});

describe('allocateDiscounts', () => {
  it('spreads a bill discount over what the lines have left, exactly', () => {
    const lines = [
      { id: 'a', amountPaise: 50_000n },
      { id: 'b', amountPaise: 33_350n },
    ];
    const r = allocateDiscounts(lines, new Map([['a', 10_000n]]), 10_001n);
    expect(r.billLevelPaise).toBe(10_001n);
    expect(r.perLine.get('a')! + r.perLine.get('b')!).toBe(20_001n);
    // 'a' keeps 40,000 and 'b' 33,350 after the line discount: shares 5,454 / 4,547 (largest remainder).
    expect(r.perLine.get('a')).toBe(15_454n);
    expect(r.perLine.get('b')).toBe(4_547n);
  });

  it('caps at what is left', () => {
    const r = allocateDiscounts([{ id: 'a', amountPaise: 1_000n }], new Map(), 5_000n);
    expect(r.billLevelPaise).toBe(1_000n);
    expect(r.perLine.get('a')).toBe(1_000n);
  });

  it('never gives a line more than its amount and adds up (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 8 }),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        (amounts, billD, ownD) => {
          const lines = amounts.map((a, i) => ({ id: `l${i}`, amountPaise: a }));
          const own = new Map([['l0', ownD]]);
          const r = allocateDiscounts(lines, own, billD);
          let sum = 0n;
          for (const l of lines) {
            const d = r.perLine.get(l.id)!;
            expect(d).toBeGreaterThanOrEqual(0n);
            expect(d).toBeLessThanOrEqual(l.amountPaise);
            sum += d;
          }
          const first = ownD > amounts[0]! ? amounts[0]! : ownD;
          expect(sum).toBe(first + r.billLevelPaise);
        },
      ),
    );
  });
});

describe('refundDue and creditableOf (docs/04 §15.8)', () => {
  const bill = { patientSharePaise: 100_000n, creditedPaise: 0n, paidPaise: 100_000n };

  it('refunds exactly what was paid beyond the reduced bill', () => {
    expect(refundDue(bill, 100_000n)).toBe(100_000n);
    expect(refundDue(bill, 30_000n)).toBe(30_000n);
    expect(refundDue({ ...bill, paidPaise: 60_000n }, 30_000n)).toBe(0n); // still owes 10,000
    expect(refundDue({ ...bill, paidPaise: 60_000n }, 50_000n)).toBe(10_000n);
    expect(refundDue({ ...bill, paidPaise: 0n }, 100_000n)).toBe(0n);
    expect(creditableOf({ ...bill, creditedPaise: 40_000n })).toBe(60_000n);
  });

  it('never refunds more than was paid or a negative amount (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.bigInt({ min: 1n, max: 100n }),
        (share, creditedPct, paidPct, creditPct) => {
          const credited = (share * creditedPct) / 100n;
          const maxPaid = share - credited;
          const paid = (maxPaid * paidPct) / 100n;
          const credit = ((share - credited) * creditPct) / 100n || 1n;
          if (credit > share - credited) return;
          const due = refundDue(
            { patientSharePaise: share, creditedPaise: credited, paidPaise: paid },
            credit,
          );
          expect(due).toBeGreaterThanOrEqual(0n);
          expect(due).toBeLessThanOrEqual(paid);
          // After the refund the bill is not overpaid.
          expect(paid - due).toBeLessThanOrEqual(share - credited - credit);
        },
      ),
    );
  });
});

describe('splitCredit', () => {
  const bill = {
    cgstPaise: 5_400n,
    sgstPaise: 5_400n,
    patientSharePaise: 120_800n,
    creditedPaise: 0n,
    creditedCgstPaise: 0n,
    creditedSgstPaise: 0n,
  };

  it('splits tax pro rata and gives the rest to the last credit', () => {
    const a = splitCredit(bill, 40_000n);
    expect(a.cgstPaise).toBe(a.sgstPaise);
    expect(a.taxablePaise + a.cgstPaise + a.sgstPaise).toBe(40_000n);
    const full = splitCredit(bill, 120_800n);
    expect(full).toEqual({
      taxablePaise: 120_800n - 10_800n,
      cgstPaise: 5_400n,
      sgstPaise: 5_400n,
    });
  });

  it('rejects zero and more than what is left', () => {
    expect(() => splitCredit(bill, 0n)).toThrow(RangeError);
    expect(() => splitCredit(bill, 120_801n)).toThrow(RangeError);
  });

  it('several credits add up to the bill, tax included (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 100n, max: 5_000_000n }),
        fc.integer({ min: 0, max: 50 }),
        fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 6 }),
        (share, taxPct, cuts) => {
          const half = (share * BigInt(taxPct)) / 200n;
          let b = {
            cgstPaise: half,
            sgstPaise: half,
            patientSharePaise: share,
            creditedPaise: 0n,
            creditedCgstPaise: 0n,
            creditedSgstPaise: 0n,
          };
          const parts: bigint[] = [];
          for (const c of cuts) {
            const left = creditableOf(b);
            const amount = (left * BigInt(c)) / 100n;
            if (amount > 0n) parts.push(amount);
            if (amount <= 0n) continue;
            const s = splitCredit(b, amount);
            expect(s.cgstPaise).toBe(s.sgstPaise);
            expect(s.taxablePaise).toBeGreaterThanOrEqual(0n);
            expect(s.taxablePaise + s.cgstPaise + s.sgstPaise).toBe(amount);
            b = {
              ...b,
              creditedPaise: b.creditedPaise + amount,
              creditedCgstPaise: b.creditedCgstPaise + s.cgstPaise,
              creditedSgstPaise: b.creditedSgstPaise + s.sgstPaise,
            };
          }
          const rest = creditableOf(b);
          if (rest > 0n) {
            const s = splitCredit(b, rest);
            b = {
              ...b,
              creditedPaise: b.creditedPaise + rest,
              creditedCgstPaise: b.creditedCgstPaise + s.cgstPaise,
              creditedSgstPaise: b.creditedSgstPaise + s.sgstPaise,
            };
          }
          expect(b.creditedPaise).toBe(share);
          expect(b.creditedCgstPaise).toBe(half);
          expect(b.creditedSgstPaise).toBe(half);
        },
      ),
    );
  });
});

describe('thresholds and inputs', () => {
  it('needs approval strictly above the threshold', () => {
    expect(needsApprovalAbove(100_000n, 100_000n)).toBe(false);
    expect(needsApprovalAbove(100_001n, 100_000n)).toBe(true);
  });

  it('requires a reason id on discounts and cancellations, and no forbidden text', () => {
    const base = { billId: id, idempotencyKey: key, mode: 'percent', percentBp: 500 };
    expect(applyDiscountSchema.safeParse(base).success).toBe(false); // no reason
    const ok = { ...base, reasonCodeId: id };
    expect(applyDiscountSchema.safeParse(ok).success).toBe(true);
    expect(applyDiscountSchema.safeParse({ ...ok, percentBp: 0 }).success).toBe(false);
    expect(applyDiscountSchema.safeParse({ ...ok, percentBp: 10_001 }).success).toBe(false);
    expect(applyDiscountSchema.safeParse({ ...ok, reasonText: 'ab' }).success).toBe(false);
    expect(
      applyDiscountSchema.safeParse({ ...ok, reasonText: FORBIDDEN_TERMS[0]!.examples[0]! })
        .success,
    ).toBe(false);
    expect(cancelBillSchema.safeParse({ billId: id, idempotencyKey: key }).success).toBe(false);
    expect(
      cancelBillSchema.safeParse({ billId: id, idempotencyKey: key, reasonCodeId: id }).success,
    ).toBe(true);
    expect(
      cancelBillSchema.safeParse({
        billId: id,
        idempotencyKey: key,
        reasonCodeId: id,
        refund: { mode: 'cheque' },
      }).success,
    ).toBe(false);
  });
});
