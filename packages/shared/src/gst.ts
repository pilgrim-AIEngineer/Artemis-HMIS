import {
  allocatePaise,
  applyPercentBp,
  BP_DENOMINATOR,
  divRound,
  lineAmount,
  roundOffToRupee,
  sumPaise,
  type Paise,
} from './money';

/**
 * GST per bill line (docs/02 §2, docs/12 §7.5). Tax is computed per line on the taxable value, split
 * half CGST / half SGST (intra-state only; the hospital is single-state). Exempt lines carry 0%.
 * Rates are basis points (500 = 5%); rates come from masters, never from code.
 */

export interface GstLineInput {
  /** Rate in paise per unit (snapshot taken when the line was added). */
  ratePaise: Paise;
  /** Quantity in thousandths (`quantityToMilli`). */
  qtyMilli: bigint;
  /** Line discount in paise, applied before tax. Default 0. */
  discountPaise?: Paise;
  /** GST rate in bp. Ignored (treated as 0) when `isExempt`. */
  gstRateBp: number;
  isExempt?: boolean;
  /** HSN (goods) or SAC (services), e.g. `9993`. */
  hsnSac?: string | null;
}

export interface GstLineResult {
  grossPaise: Paise;
  discountPaise: Paise;
  /** gross − discount */
  taxablePaise: Paise;
  gstRateBp: number;
  cgstPaise: Paise;
  sgstPaise: Paise;
  /** taxable + cgst + sgst */
  totalPaise: Paise;
  hsnSac: string;
}

export function computeGstLine(line: GstLineInput): GstLineResult {
  const discount = line.discountPaise ?? 0n;
  const gross = lineAmount(line.ratePaise, line.qtyMilli);
  if (gross < 0n) throw new RangeError('Line amount cannot be negative');
  if (discount < 0n || discount > gross) {
    throw new RangeError('Discount must be between 0 and the line amount');
  }
  if (!Number.isInteger(line.gstRateBp) || line.gstRateBp < 0 || line.gstRateBp > 10_000) {
    throw new RangeError(`Invalid GST rate (bp): ${line.gstRateBp}`);
  }
  const rateBp = line.isExempt ? 0 : line.gstRateBp;
  const taxable = gross - discount;
  // Each half is rounded independently from half the rate, so CGST == SGST always holds
  // (rounding the total then halving could leave an odd paisa).
  const half = divRound(taxable * BigInt(rateBp), 2n * BP_DENOMINATOR);
  return {
    grossPaise: gross,
    discountPaise: discount,
    taxablePaise: taxable,
    gstRateBp: rateBp,
    cgstPaise: half,
    sgstPaise: half,
    totalPaise: taxable + half + half,
    hsnSac: line.hsnSac?.trim() ?? '',
  };
}

export interface HsnSummaryRow {
  hsnSac: string;
  gstRateBp: number;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  taxPaise: Paise;
}

/** Taxable value + CGST + SGST per HSN/SAC and rate. Only lines with tax appear (docs/02 §2). */
export function summariseByHsn(lines: readonly GstLineResult[]): HsnSummaryRow[] {
  const rows = new Map<string, HsnSummaryRow>();
  for (const l of lines) {
    if (l.gstRateBp === 0) continue;
    const key = `${l.hsnSac}|${l.gstRateBp}`;
    const row = rows.get(key) ?? {
      hsnSac: l.hsnSac,
      gstRateBp: l.gstRateBp,
      taxablePaise: 0n,
      cgstPaise: 0n,
      sgstPaise: 0n,
      taxPaise: 0n,
    };
    row.taxablePaise += l.taxablePaise;
    row.cgstPaise += l.cgstPaise;
    row.sgstPaise += l.sgstPaise;
    row.taxPaise += l.cgstPaise + l.sgstPaise;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.hsnSac.localeCompare(b.hsnSac) || a.gstRateBp - b.gstRateBp,
  );
}

export interface BillTotals {
  lines: GstLineResult[];
  hsnSummary: HsnSummaryRow[];
  grossPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  /** gross − discount + cgst + sgst, before round-off. */
  subtotalPaise: Paise;
  /** The `round_off_paise` line (docs/02 §2); 0 when `roundToRupee` is false. */
  roundOffPaise: Paise;
  /** docs/04 §15.1: net = gross − discount + cgst + sgst + round_off. */
  netPaise: Paise;
}

export interface BillComputeOptions {
  /** Setting `billing.roundToRupee`. Default true. */
  roundToRupee?: boolean;
  /**
   * Extra bill-level discount spread across lines in proportion to their pre-discount amounts
   * (before tax, so GST is charged on the discounted value).
   */
  billDiscountPaise?: Paise;
}

export function computeBill(
  inputs: readonly GstLineInput[],
  opts: BillComputeOptions = {},
): BillTotals {
  const { roundToRupee = true, billDiscountPaise = 0n } = opts;
  let effective = inputs;
  if (billDiscountPaise !== 0n) {
    if (billDiscountPaise < 0n) throw new RangeError('Bill discount cannot be negative');
    // Capacity of each line to absorb more discount.
    const headroom = inputs.map(
      (l) => lineAmount(l.ratePaise, l.qtyMilli) - (l.discountPaise ?? 0n),
    );
    if (billDiscountPaise > sumPaise(headroom)) {
      throw new RangeError('Bill discount exceeds the payable amount');
    }
    const shares = allocatePaise(billDiscountPaise, headroom);
    effective = inputs.map((l, i) => ({
      ...l,
      discountPaise: (l.discountPaise ?? 0n) + (shares[i] ?? 0n),
    }));
  }
  const lines = effective.map(computeGstLine);
  const grossPaise = sumPaise(lines.map((l) => l.grossPaise));
  const discountPaise = sumPaise(lines.map((l) => l.discountPaise));
  const taxablePaise = grossPaise - discountPaise;
  const cgstPaise = sumPaise(lines.map((l) => l.cgstPaise));
  const sgstPaise = sumPaise(lines.map((l) => l.sgstPaise));
  const subtotalPaise = taxablePaise + cgstPaise + sgstPaise;
  const roundOffPaise = roundToRupee ? roundOffToRupee(subtotalPaise) : 0n;
  return {
    lines,
    hsnSummary: summariseByHsn(lines),
    grossPaise,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    subtotalPaise,
    roundOffPaise,
    netPaise: subtotalPaise + roundOffPaise,
  };
}

/** Flat discount helper: `percentBp` of `amount`, never above the amount. */
export function percentDiscount(amount: Paise, percentBp: number): Paise {
  const d = applyPercentBp(amount, percentBp);
  return d > amount ? amount : d;
}
