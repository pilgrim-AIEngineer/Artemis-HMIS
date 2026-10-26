import { describe, expect, it } from 'vitest';
import {
  businessDateFor,
  closeOwnDaySchema,
  closeVariance,
  countedCashPaise,
  denominationsSchema,
  EMPTY_DENOMINATIONS,
  matchUpiStatement,
  modeTotals,
  parseUpiStatement,
  totalOfModes,
  upiDifference,
  type UpiStatementLine,
} from './day-close';

const KEY = '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('denomination counter', () => {
  it('adds notes at face value and the coins, in paise', () => {
    const d = denominationsSchema.parse({
      n500: 3,
      n200: 1,
      n100: 4,
      n50: 2,
      n20: 5,
      n10: 7,
      coinsPaise: '12550',
    });
    // 1500 + 200 + 400 + 100 + 100 + 70 = 2370 rupees + 125.50
    expect(countedCashPaise(d)).toBe(249550n);
  });

  it('an empty drawer counts to zero', () => {
    expect(countedCashPaise(EMPTY_DENOMINATIONS)).toBe(0n);
  });

  it('refuses negative or fractional counts and negative coins', () => {
    const base = { n500: 0, n200: 0, n100: 0, n50: 0, n20: 0, n10: 0, coinsPaise: 0 };
    expect(denominationsSchema.safeParse({ ...base, n500: -1 }).success).toBe(false);
    expect(denominationsSchema.safeParse({ ...base, n100: 1.5 }).success).toBe(false);
    expect(denominationsSchema.safeParse({ ...base, coinsPaise: -5 }).success).toBe(false);
    expect(denominationsSchema.safeParse({ ...base, n10: 1_000_000 }).success).toBe(false);
  });
});

describe('variance', () => {
  it('is counted minus expected and needs a reason only when not zero', () => {
    expect(closeVariance(100000n, 100000n)).toEqual({ differencePaise: 0n, reasonRequired: false });
    expect(closeVariance(100000n, 99000n)).toEqual({
      differencePaise: -1000n,
      reasonRequired: true,
    });
    expect(closeVariance(100000n, 100050n)).toEqual({ differencePaise: 50n, reasonRequired: true });
  });

  it('a refund lowers the expected cash (negative amounts)', () => {
    const t = modeTotals([
      { mode: 'cash', amountPaise: 150000n },
      { mode: 'cash', amountPaise: -50000n },
      { mode: 'upi', amountPaise: 20000n },
      { mode: 'card', amountPaise: 30000n },
      { mode: 'cheque', amountPaise: 1000n },
    ]);
    expect(t).toEqual({
      cashPaise: 100000n,
      upiPaise: 20000n,
      cardPaise: 30000n,
      otherPaise: 1000n,
    });
    expect(totalOfModes(t)).toBe(151000n);
  });
});

describe('closed periods: payments after close go to the next day', () => {
  it('stays on its own day while the facility is not closed that far', () => {
    expect(businessDateFor('2026-10-26', null)).toBe('2026-10-26');
    expect(businessDateFor('2026-10-26', '2026-10-25')).toBe('2026-10-26');
  });

  it('moves to the day after the last close when its day is already closed', () => {
    expect(businessDateFor('2026-10-26', '2026-10-26')).toBe('2026-10-27');
    expect(businessDateFor('2026-10-24', '2026-10-26')).toBe('2026-10-27');
  });

  it('rolls over month and year ends', () => {
    expect(businessDateFor('2026-12-31', '2026-12-31')).toBe('2027-01-01');
    expect(businessDateFor('2027-02-28', '2027-02-28')).toBe('2027-03-01');
  });
});

describe('close input', () => {
  const den = { n500: 1, n200: 0, n100: 0, n50: 0, n20: 0, n10: 0, coinsPaise: 0 };
  it('accepts a string expected cash and an empty reason', () => {
    const r = closeOwnDaySchema.parse({
      denominations: den,
      expectedCashPaise: '50000',
      differenceReason: '  ',
      idempotencyKey: KEY,
    });
    expect(r.expectedCashPaise).toBe(50000n);
    expect(r.differenceReason).toBeUndefined();
  });

  it('refuses a reason carrying a forbidden term (D-10)', () => {
    const r = closeOwnDaySchema.safeParse({
      denominations: den,
      expectedCashPaise: '50000',
      differenceReason: 'fetal sex check fee',
      idempotencyKey: KEY,
    });
    expect(r.success).toBe(false);
  });
});

describe('UPI statement parsing and UTR matching', () => {
  it('reads UTR + amount lines in several shapes and flags the rest', () => {
    const { lines, badLines } = parseUpiStatement(
      [
        '412345678901, 500.00',
        '512345678902\t1,250',
        'UPI 612345678903 Dr 100.50',
        '712345678904 -200',
        '',
        'garbage line',
      ].join('\n'),
    );
    expect(lines).toEqual([
      { utr: '412345678901', amountPaise: 50000n },
      { utr: '512345678902', amountPaise: 125000n },
      { utr: '612345678903', amountPaise: -10050n },
      { utr: '712345678904', amountPaise: -20000n },
    ]);
    expect(badLines).toEqual([6]);
  });

  const line = (utr: string, amountPaise: bigint): UpiStatementLine => ({ utr, amountPaise });

  it('matches on amount and the trailing UTR digits', () => {
    const r = matchUpiStatement(
      [
        { id: 'p1', amountPaise: 50000n, upiRef: '8901' },
        { id: 'p2', amountPaise: 30000n, upiRef: '5555' },
        { id: 'p3', amountPaise: 70000n, upiRef: null },
      ],
      [line('412345678901', 50000n), line('412345675555', 31000n), line('999999999999', 70000n)],
    );
    expect(r.matches).toEqual([{ paymentId: 'p1', lineIndex: 0, utr: '412345678901' }]);
    expect(r.unmatchedPaymentIds).toEqual(['p2', 'p3']);
    expect(r.unmatchedLineIndexes).toEqual([1, 2]);
  });

  it('does not guess between two candidates', () => {
    const r = matchUpiStatement(
      [{ id: 'p1', amountPaise: 50000n, upiRef: '8901' }],
      [line('412345678901', 50000n), line('999999998901', 50000n)],
    );
    expect(r.matches).toEqual([]);
  });

  it('does not let two receipts with the same ending claim one line', () => {
    const r = matchUpiStatement(
      [
        { id: 'p1', amountPaise: 50000n, upiRef: '8901' },
        { id: 'p2', amountPaise: 50000n, upiRef: '8901' },
      ],
      [line('412345678901', 50000n)],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedPaymentIds).toEqual(['p1', 'p2']);
  });

  it('matches a UPI refund (negative on both sides)', () => {
    const r = matchUpiStatement(
      [{ id: 'r1', amountPaise: -20000n, upiRef: '1234' }],
      [line('600000001234', -20000n)],
    );
    expect(r.matches).toHaveLength(1);
  });

  it('difference is statement minus system', () => {
    expect(upiDifference(100000n, 99000n)).toBe(-1000n);
  });
});
