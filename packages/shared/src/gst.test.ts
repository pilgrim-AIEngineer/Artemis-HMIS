import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeBill,
  computeGstLine,
  percentDiscount,
  summariseByHsn,
  type GstLineInput,
} from './gst';
import { quantityToMilli } from './money';

const line = (over: Partial<GstLineInput> = {}): GstLineInput => ({
  ratePaise: 100_000n,
  qtyMilli: 1000n,
  gstRateBp: 0,
  ...over,
});

describe('computeGstLine', () => {
  it('splits 5% equally into CGST and SGST (2.5% each)', () => {
    const r = computeGstLine(line({ ratePaise: 600_000n, gstRateBp: 500, hsnSac: '996311' }));
    expect(r).toMatchObject({
      grossPaise: 600_000n,
      taxablePaise: 600_000n,
      cgstPaise: 15_000n,
      sgstPaise: 15_000n,
      totalPaise: 630_000n,
      hsnSac: '996311',
    });
  });

  it('applies the line discount before tax', () => {
    const r = computeGstLine(
      line({ ratePaise: 600_000n, discountPaise: 100_000n, gstRateBp: 500 }),
    );
    expect(r.taxablePaise).toBe(500_000n);
    expect(r.cgstPaise).toBe(12_500n);
    expect(r.totalPaise).toBe(525_000n);
  });

  it('treats exempt lines as 0% whatever the rate says', () => {
    const r = computeGstLine(line({ gstRateBp: 1800, isExempt: true, hsnSac: '9993' }));
    expect(r.gstRateBp).toBe(0);
    expect(r.cgstPaise + r.sgstPaise).toBe(0n);
    expect(r.totalPaise).toBe(100_000n);
  });

  it('keeps CGST equal to SGST even when the odd paisa would split unevenly', () => {
    // 5% of ₹0.99 = 4.95 paise total tax; each half is 2.475 → 2 paise.
    const r = computeGstLine(line({ ratePaise: 99n, gstRateBp: 500 }));
    expect(r.cgstPaise).toBe(r.sgstPaise);
    expect(r.cgstPaise).toBe(2n);
  });

  it('handles fractional quantities and 12% / 18% rates', () => {
    const r = computeGstLine({
      ratePaise: 12_345n,
      qtyMilli: quantityToMilli('2.5'),
      gstRateBp: 1200,
    });
    expect(r.grossPaise).toBe(30_863n); // 30,862.5 → 30,863
    expect(r.cgstPaise).toBe(1_852n); // 6% of 30,863 = 1,851.78
    expect(r.cgstPaise).toBe(r.sgstPaise);
  });

  it('validates inputs', () => {
    expect(() => computeGstLine(line({ discountPaise: 100_001n }))).toThrow(RangeError);
    expect(() => computeGstLine(line({ discountPaise: -1n }))).toThrow(RangeError);
    expect(() => computeGstLine(line({ ratePaise: -1n }))).toThrow(RangeError);
    expect(() => computeGstLine(line({ gstRateBp: -1 }))).toThrow(RangeError);
    expect(() => computeGstLine(line({ gstRateBp: 10_001 }))).toThrow(RangeError);
    expect(() => computeGstLine(line({ gstRateBp: 12.5 }))).toThrow(RangeError);
  });
});

describe('summariseByHsn', () => {
  it('groups taxable lines by HSN/SAC and rate, skipping exempt lines', () => {
    const lines = [
      line({ ratePaise: 600_000n, gstRateBp: 500, hsnSac: '996311' }),
      line({ ratePaise: 600_000n, gstRateBp: 500, hsnSac: '996311' }),
      line({ ratePaise: 100_000n, gstRateBp: 1800, hsnSac: '9997' }),
      line({ ratePaise: 100_000n, gstRateBp: 0, isExempt: true, hsnSac: '9993' }),
    ].map(computeGstLine);
    expect(summariseByHsn(lines)).toEqual([
      {
        hsnSac: '996311',
        gstRateBp: 500,
        taxablePaise: 1_200_000n,
        cgstPaise: 30_000n,
        sgstPaise: 30_000n,
        taxPaise: 60_000n,
      },
      {
        hsnSac: '9997',
        gstRateBp: 1800,
        taxablePaise: 100_000n,
        cgstPaise: 9_000n,
        sgstPaise: 9_000n,
        taxPaise: 18_000n,
      },
    ]);
  });

  it('is empty when nothing is taxable', () => {
    expect(summariseByHsn([computeGstLine(line({ isExempt: true }))])).toEqual([]);
  });

  it('keeps one row per rate when the same code has two rates', () => {
    const rows = summariseByHsn(
      [line({ gstRateBp: 500, hsnSac: '3004' }), line({ gstRateBp: 1200, hsnSac: '3004' })].map(
        computeGstLine,
      ),
    );
    expect(rows.map((r) => r.gstRateBp)).toEqual([500, 1200]);
  });
});

interface GeneratedLine {
  ratePaise: bigint;
  qtyMilli: bigint;
  gstRateBp: number;
  isExempt: boolean;
  discountFraction: number;
  hsnSac: string | null;
}

describe('computeBill', () => {
  it('computes the OPD consultation + USG example with round-off', () => {
    const b = computeBill([
      line({ ratePaise: 50_000n, hsnSac: '9993', isExempt: true }),
      line({ ratePaise: 80_050n, hsnSac: '9993', isExempt: true }),
    ]);
    expect(b.subtotalPaise).toBe(130_050n);
    expect(b.roundOffPaise).toBe(50n);
    expect(b.netPaise).toBe(130_100n);
    expect(b.hsnSummary).toEqual([]);
  });

  it('adds room GST (> ₹5,000/day at 5%) and rounds down when under 50 paise', () => {
    const b = computeBill([
      line({ ratePaise: 600_000n, gstRateBp: 500, hsnSac: '996311' }),
      line({ ratePaise: 12_333n, isExempt: true, hsnSac: '9993' }),
    ]);
    expect(b.cgstPaise).toBe(15_000n);
    expect(b.sgstPaise).toBe(15_000n);
    expect(b.subtotalPaise).toBe(642_333n);
    expect(b.roundOffPaise).toBe(-33n);
    expect(b.netPaise).toBe(642_300n);
  });

  it('skips round-off when billing.roundToRupee is false', () => {
    const b = computeBill([line({ ratePaise: 12_345n })], { roundToRupee: false });
    expect(b.roundOffPaise).toBe(0n);
    expect(b.netPaise).toBe(12_345n);
  });

  it('spreads a bill-level discount across lines before tax', () => {
    const b = computeBill(
      [
        line({ ratePaise: 600_000n, gstRateBp: 500, hsnSac: '996311' }),
        line({ ratePaise: 400_000n, isExempt: true }),
      ],
      { billDiscountPaise: 100_000n },
    );
    expect(b.discountPaise).toBe(100_000n);
    expect(b.lines.map((l) => l.discountPaise)).toEqual([60_000n, 40_000n]);
    expect(b.taxablePaise).toBe(900_000n);
    expect(b.cgstPaise).toBe(13_500n); // 2.5% of 540,000
    expect(b.netPaise).toBe(927_000n);
  });

  it('rejects a bill discount larger than what is payable', () => {
    expect(() => computeBill([line()], { billDiscountPaise: 100_001n })).toThrow(RangeError);
    expect(() => computeBill([line()], { billDiscountPaise: -1n })).toThrow(RangeError);
  });

  it('handles an empty bill', () => {
    const b = computeBill([]);
    expect(b.netPaise).toBe(0n);
    expect(b.lines).toEqual([]);
  });

  it('percentDiscount never exceeds the amount', () => {
    expect(percentDiscount(100_000n, 1000)).toBe(10_000n);
    expect(percentDiscount(100_000n, 10_000)).toBe(100_000n);
  });

  describe('property: docs/04 §15.1 invariants', () => {
    const lineArb = fc.record({
      ratePaise: fc.bigInt({ min: 0n, max: 5_000_000n }),
      qtyMilli: fc.bigInt({ min: 0n, max: 20_000n }),
      gstRateBp: fc.constantFrom(0, 250, 500, 1200, 1800, 2800),
      isExempt: fc.boolean(),
      discountFraction: fc.integer({ min: 0, max: 100 }),
      hsnSac: fc.constantFrom('9993', '996311', '3004', null),
    });

    const toInputs = (xs: GeneratedLine[]): GstLineInput[] =>
      xs.map((x) => {
        const gross = (x.ratePaise * x.qtyMilli + 500n) / 1000n;
        return {
          ratePaise: x.ratePaise,
          qtyMilli: x.qtyMilli,
          gstRateBp: x.gstRateBp,
          isExempt: x.isExempt,
          hsnSac: x.hsnSac,
          discountPaise: (gross * BigInt(x.discountFraction)) / 100n,
        };
      });

    it('net = gross − discount + cgst + sgst + round_off, CGST = SGST, whole-rupee net', () => {
      fc.assert(
        fc.property(fc.array(lineArb, { maxLength: 15 }), fc.boolean(), (xs, roundToRupee) => {
          const b = computeBill(toInputs(xs), { roundToRupee });
          expect(b.netPaise).toBe(
            b.grossPaise - b.discountPaise + b.cgstPaise + b.sgstPaise + b.roundOffPaise,
          );
          expect(b.cgstPaise).toBe(b.sgstPaise);
          if (roundToRupee) {
            expect(b.netPaise % 100n).toBe(0n);
            expect(b.roundOffPaise >= 0n ? b.roundOffPaise : -b.roundOffPaise).toBeLessThanOrEqual(
              50n,
            );
          } else {
            expect(b.roundOffPaise).toBe(0n);
          }
          expect(b.lines.reduce((s, l) => s + l.totalPaise, 0n)).toBe(b.subtotalPaise);
          // HSN summary reconciles to the bill's tax.
          const hsn = b.hsnSummary;
          expect(hsn.reduce((s, r) => s + r.cgstPaise, 0n)).toBe(b.cgstPaise);
          expect(hsn.reduce((s, r) => s + r.sgstPaise, 0n)).toBe(b.sgstPaise);
        }),
      );
    });

    it('a bill-level discount keeps the invariant and lands exactly on the discount', () => {
      fc.assert(
        fc.property(
          fc.array(lineArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 0, max: 100 }),
          (xs, pct) => {
            const inputs = toInputs(xs);
            const base = computeBill(inputs, { roundToRupee: false });
            const extra = (base.taxablePaise * BigInt(pct)) / 100n;
            const b = computeBill(inputs, { billDiscountPaise: extra });
            expect(b.discountPaise).toBe(base.discountPaise + extra);
            expect(b.netPaise).toBe(
              b.grossPaise - b.discountPaise + b.cgstPaise + b.sgstPaise + b.roundOffPaise,
            );
            b.lines.forEach((l) => expect(l.taxablePaise).toBeGreaterThanOrEqual(0n));
          },
        ),
      );
    });
  });
});
