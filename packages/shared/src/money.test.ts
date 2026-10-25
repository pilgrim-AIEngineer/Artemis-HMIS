import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocatePaise,
  applyPercentBp,
  bpToPercent,
  divRound,
  formatINR,
  groupIndian,
  lineAmount,
  paiseToRupees,
  percentToBp,
  quantityToMilli,
  roundOffToRupee,
  rupeesToPaise,
  sumPaise,
} from './money';

const paise = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

describe('rupeesToPaise', () => {
  it.each([
    ['0', 0n],
    ['1', 100n],
    ['123.45', 12345n],
    ['123.4', 12340n],
    ['0.05', 5n],
    ['.5'.replace('.', '0.'), 50n],
    ['-5.50', -550n],
    ['+7', 700n],
    [' 99.99 ', 9999n],
    ['1234567.89', 123456789n],
  ])('parses %s', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it('accepts bigint and integer-number whole rupees', () => {
    expect(rupeesToPaise(12n)).toBe(1200n);
    expect(rupeesToPaise(12)).toBe(1200n);
  });

  it.each(['', 'abc', '1.234', '1,000', '1e3', '₹5', '--5', '5.', '.5', '1 2'])(
    'rejects %j (never rounds money silently)',
    (input) => {
      expect(() => rupeesToPaise(input)).toThrow(SyntaxError);
    },
  );

  it('rejects floats and unsafe numbers', () => {
    expect(() => rupeesToPaise(1.5)).toThrow(TypeError);
    expect(() => rupeesToPaise(Number.NaN)).toThrow(TypeError);
    expect(() => rupeesToPaise(2 ** 60)).toThrow(TypeError);
  });
});

describe('paiseToRupees', () => {
  it.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [100n, '1.00'],
    [12345n, '123.45'],
    [-5n, '-0.05'],
    [-12345n, '-123.45'],
  ])('%s → %s', (p, s) => {
    expect(paiseToRupees(p)).toBe(s);
  });

  it('round-trips with rupeesToPaise for any bigint (exact, no float)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n }), (p) => {
        expect(rupeesToPaise(paiseToRupees(p))).toBe(p);
      }),
    );
  });
});

describe('formatINR', () => {
  it.each([
    [0n, '₹0.00'],
    [5n, '₹0.05'],
    [99999n, '₹999.99'],
    [100000n, '₹1,000.00'],
    [12345600n, '₹1,23,456.00'],
    [123456789n, '₹12,34,567.89'],
    [1000000000n, '₹1,00,00,000.00'],
    [-120000n, '-₹1,200.00'],
    [-5n, '-₹0.05'],
  ])('%s → %s', (p, s) => {
    expect(formatINR(p)).toBe(s);
  });

  it('supports no symbol and auto decimals', () => {
    expect(formatINR(12345600n, { symbol: false })).toBe('1,23,456.00');
    expect(formatINR(50000n, { decimals: 'auto' })).toBe('₹500');
    expect(formatINR(50050n, { decimals: 'auto' })).toBe('₹500.50');
    expect(formatINR(-50000n, { symbol: false, decimals: 'auto' })).toBe('-500');
  });

  it('groups digits 3 then 2s', () => {
    expect(groupIndian('1')).toBe('1');
    expect(groupIndian('999')).toBe('999');
    expect(groupIndian('1000')).toBe('1,000');
    expect(groupIndian('12345')).toBe('12,345');
    expect(groupIndian('123456')).toBe('1,23,456');
    expect(groupIndian('1234567')).toBe('12,34,567');
    expect(groupIndian('12345678901')).toBe('12,34,56,78,901');
  });

  it('property: stripping separators recovers paiseToRupees', () => {
    fc.assert(
      fc.property(paise, (p) => {
        expect(formatINR(p).replace(/[₹,]/g, '')).toBe(paiseToRupees(p));
      }),
    );
  });

  it('property: grouping never splits into groups other than 3 then 2s', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (n) => {
        const groups = groupIndian(String(n)).split(',');
        const last = groups.pop();
        if (groups.length > 0) expect(last).toHaveLength(3);
        groups.slice(1).forEach((g) => expect(g).toHaveLength(2));
        if (groups[0]) expect(groups[0].length).toBeLessThanOrEqual(2);
      }),
    );
  });
});

describe('sumPaise', () => {
  it('sums exactly, including empty and negatives', () => {
    expect(sumPaise([])).toBe(0n);
    expect(sumPaise([1n, 2n, -5n])).toBe(-2n);
    expect(sumPaise(new Set([10n, 20n]))).toBe(30n);
  });

  it('is order independent (no float drift)', () => {
    fc.assert(
      fc.property(fc.array(paise, { maxLength: 40 }), (xs) => {
        expect(sumPaise(xs)).toBe(sumPaise([...xs].reverse()));
      }),
    );
  });
});

describe('divRound', () => {
  it('rounds ties away from zero by default', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
    expect(divRound(7n, 3n)).toBe(2n);
  });

  it('supports floor and ceil', () => {
    expect(divRound(7n, 2n, 'floor')).toBe(3n);
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(7n, 2n, 'ceil')).toBe(4n);
    expect(divRound(-7n, 2n, 'ceil')).toBe(-3n);
    expect(divRound(6n, 2n, 'ceil')).toBe(3n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
    expect(() => divRound(1n, -1n)).toThrow(RangeError);
  });

  it('property: result is within half a unit of the exact quotient', () => {
    fc.assert(
      fc.property(paise, fc.bigInt({ min: 1n, max: 100_000n }), (n, d) => {
        const q = divRound(n, d);
        const diff = (q * d - n) * 2n;
        expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(d);
      }),
    );
  });
});

describe('applyPercentBp', () => {
  it('computes percentages in basis points', () => {
    expect(applyPercentBp(100_000n, 500)).toBe(5_000n); // 5% of ₹1,000
    expect(applyPercentBp(100_000n, 1250)).toBe(12_500n);
    expect(applyPercentBp(100_000n, 0)).toBe(0n);
    expect(applyPercentBp(100_000n, 10_000)).toBe(100_000n);
    expect(applyPercentBp(100_000n, 250n)).toBe(2_500n);
  });

  it('rounds half away from zero to whole paise', () => {
    expect(applyPercentBp(1999n, 500)).toBe(100n); // 99.95
    expect(applyPercentBp(1990n, 500)).toBe(100n); // 99.5 → 100
    expect(applyPercentBp(1989n, 500)).toBe(99n); // 99.45
    expect(applyPercentBp(-1990n, 500)).toBe(-100n);
    expect(applyPercentBp(1999n, 500, 'floor')).toBe(99n);
    expect(applyPercentBp(1991n, 500, 'ceil')).toBe(100n);
  });

  it('rejects fractional basis points', () => {
    expect(() => applyPercentBp(100n, 12.5)).toThrow(TypeError);
  });

  it('property: 0 ≤ result ≤ amount for bp in [0, 10000]', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 10_000 }),
        (a, bp) => {
          const r = applyPercentBp(a, bp);
          expect(r).toBeGreaterThanOrEqual(0n);
          expect(r).toBeLessThanOrEqual(a);
        },
      ),
    );
  });

  it('property: odd symmetry and monotonic in bp', () => {
    fc.assert(
      fc.property(paise, fc.integer({ min: 0, max: 9_999 }), (a, bp) => {
        expect(applyPercentBp(-a, bp)).toBe(-applyPercentBp(a, bp));
        if (a >= 0n) {
          expect(applyPercentBp(a, bp + 1)).toBeGreaterThanOrEqual(applyPercentBp(a, bp));
        }
      }),
    );
  });

  it('property: |result − exact| ≤ 0.5 paise', () => {
    fc.assert(
      fc.property(paise, fc.integer({ min: 0, max: 10_000 }), (a, bp) => {
        const r = applyPercentBp(a, bp);
        const err2 = (r * 10_000n - a * BigInt(bp)) * 2n;
        expect(err2 < 0n ? -err2 : err2).toBeLessThanOrEqual(10_000n);
      }),
    );
  });
});

describe('percent ↔ bp', () => {
  it('converts', () => {
    expect(percentToBp('5')).toBe(500);
    expect(percentToBp('12.5')).toBe(1250);
    expect(percentToBp('2.75')).toBe(275);
    expect(bpToPercent(500)).toBe('5');
    expect(bpToPercent(1250)).toBe('12.5');
    expect(bpToPercent(275)).toBe('2.75');
    expect(bpToPercent(0)).toBe('0');
  });

  it('rejects bad input', () => {
    expect(() => percentToBp('1.234')).toThrow(SyntaxError);
    expect(() => percentToBp('-1')).toThrow(SyntaxError);
    expect(() => percentToBp('1000')).toThrow(RangeError);
    expect(() => percentToBp('100.01')).toThrow(RangeError);
    expect(percentToBp('100')).toBe(10_000);
    expect(percentToBp('1000', 100_000)).toBe(100_000);
    expect(() => bpToPercent(-1)).toThrow(RangeError);
    expect(() => bpToPercent(1.5)).toThrow(RangeError);
  });

  it('property: round trip', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (bp) => {
        expect(percentToBp(bpToPercent(bp), 100_000)).toBe(bp);
      }),
    );
  });
});

describe('quantities and line amounts', () => {
  it('parses numeric(12,3) quantities to thousandths', () => {
    expect(quantityToMilli('1')).toBe(1000n);
    expect(quantityToMilli('1.5')).toBe(1500n);
    expect(quantityToMilli('0.125')).toBe(125n);
    expect(quantityToMilli(3)).toBe(3000n);
    expect(quantityToMilli(2n)).toBe(2000n);
    expect(() => quantityToMilli('1.0001')).toThrow(SyntaxError);
    expect(() => quantityToMilli(1.5)).toThrow(TypeError);
    expect(() => quantityToMilli('-1')).toThrow(SyntaxError);
  });

  it('multiplies rate × qty exactly then rounds once', () => {
    expect(lineAmount(50_000n, 1000n)).toBe(50_000n);
    expect(lineAmount(50_000n, 2500n)).toBe(125_000n);
    expect(lineAmount(333n, 500n)).toBe(167n); // 166.5 → 167
    expect(lineAmount(333n, 0n)).toBe(0n);
  });
});

describe('allocatePaise', () => {
  it('distributes the remainder by largest fraction, earlier index on ties', () => {
    expect(allocatePaise(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocatePaise(10n, [3n, 7n])).toEqual([3n, 7n]);
    expect(allocatePaise(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocatePaise(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });

  it('handles degenerate inputs', () => {
    expect(allocatePaise(0n, [])).toEqual([]);
    expect(allocatePaise(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(() => allocatePaise(1n, [])).toThrow(RangeError);
    expect(() => allocatePaise(1n, [0n, 0n])).toThrow(RangeError);
    expect(() => allocatePaise(1n, [1n, -1n])).toThrow(RangeError);
  });

  it('property: shares sum to the total, are non-negative, and zero weights get zero', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 7n }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(sumPaise(weights) > 0n);
          const shares = allocatePaise(total, weights);
          expect(sumPaise(shares)).toBe(total);
          shares.forEach((s, i) => {
            expect(s).toBeGreaterThanOrEqual(0n);
            if (weights[i] === 0n) expect(s).toBe(0n);
          });
        },
      ),
    );
  });
});

describe('roundOffToRupee', () => {
  it('rounds to the nearest rupee, 50 paise rounds up', () => {
    expect(roundOffToRupee(10_000n)).toBe(0n);
    expect(roundOffToRupee(10_049n)).toBe(-49n);
    expect(roundOffToRupee(10_050n)).toBe(50n);
    expect(roundOffToRupee(10_051n)).toBe(49n);
    expect(roundOffToRupee(10_099n)).toBe(1n);
    expect(roundOffToRupee(0n)).toBe(0n);
  });

  it('is symmetric for credit notes (negative totals)', () => {
    expect(roundOffToRupee(-10_049n)).toBe(49n);
    expect(roundOffToRupee(-10_050n)).toBe(-50n);
    expect(roundOffToRupee(-10_051n)).toBe(-49n);
  });

  it('property: total + round-off is a whole rupee within 50 paise', () => {
    fc.assert(
      fc.property(paise, (t) => {
        const r = roundOffToRupee(t);
        expect((t + r) % 100n).toBe(0n);
        expect(r >= 0n ? r : -r).toBeLessThanOrEqual(50n);
      }),
    );
  });
});
