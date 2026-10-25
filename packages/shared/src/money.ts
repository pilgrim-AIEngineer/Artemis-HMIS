/**
 * Money is integer paise (AGENTS.md rule 1). Everything here is `bigint`; there is no float path.
 * Rupee amounts enter as decimal strings at the edge and leave as decimal strings / formatted text.
 */

export type Paise = bigint;

export const PAISE_PER_RUPEE = 100n;
/** Basis points: 10_000 bp = 100%. GST 5% = 500 bp (AGENTS.md rule 1). */
export const BP_DENOMINATOR = 10_000n;

export type RoundingMode =
  /** Ties away from zero (50 paise → up for credits and debits alike). Default everywhere. */
  'half-up' | 'floor' | 'ceil';

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** `numerator / denominator` rounded to an integer. `denominator` must be > 0. */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const q = numerator / denominator; // truncates toward zero
  const r = numerator % denominator;
  if (r === 0n) return q;
  switch (mode) {
    case 'floor':
      return numerator < 0n ? q - 1n : q;
    case 'ceil':
      return numerator < 0n ? q : q + 1n;
    case 'half-up':
      if (abs(r) * 2n >= denominator) return numerator < 0n ? q - 1n : q + 1n;
      return q;
  }
}

const RUPEE_INPUT = /^([+-])?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a rupee amount to paise: `"123"`, `"123.4"`, `"123.45"`, `"-5.50"`, or a `bigint`/integer
 * number of whole rupees. More than two decimals, floats, exponents and thousands separators throw
 * (callers strip UI formatting first); never silently round money.
 */
export function rupeesToPaise(rupees: string | bigint | number): Paise {
  if (typeof rupees === 'bigint') return rupees * PAISE_PER_RUPEE;
  if (typeof rupees === 'number') {
    if (!Number.isSafeInteger(rupees)) {
      throw new TypeError('rupeesToPaise: numbers must be whole rupees; pass decimals as strings');
    }
    return BigInt(rupees) * PAISE_PER_RUPEE;
  }
  const m = RUPEE_INPUT.exec(rupees.trim());
  if (!m) throw new SyntaxError(`Invalid rupee amount: ${JSON.stringify(rupees)}`);
  const [, sign, whole = '0', frac = ''] = m;
  const paise = BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, '0'));
  return sign === '-' ? -paise : paise;
}

/** Exact decimal string with two places: `12345n → "123.45"`, `-5n → "-0.05"`. */
export function paiseToRupees(paise: Paise): string {
  const neg = paise < 0n;
  const a = abs(paise);
  const whole = a / PAISE_PER_RUPEE;
  const frac = String(a % PAISE_PER_RUPEE).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Indian digit grouping of a non-negative integer string: `1234567 → 12,34,567`. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

export interface FormatINROptions {
  /** `false` drops the ₹ sign (for table columns that already say "₹"). Default true. */
  symbol?: boolean;
  /** `'auto'` omits `.00` for whole rupees. Default `'always'`: ₹1,23,456.00. */
  decimals?: 'always' | 'auto';
}

/** `₹1,23,456.00`; negatives render `-₹1,200.00`. */
export function formatINR(paise: Paise, opts: FormatINROptions = {}): string {
  const { symbol = true, decimals = 'always' } = opts;
  const neg = paise < 0n;
  const a = abs(paise);
  const whole = groupIndian(String(a / PAISE_PER_RUPEE));
  const frac = a % PAISE_PER_RUPEE;
  const body =
    decimals === 'auto' && frac === 0n ? whole : `${whole}.${String(frac).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${symbol ? '₹' : ''}${body}`;
}

export function sumPaise(values: Iterable<Paise>): Paise {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/**
 * `amount × bp / 10_000`, rounded (default half away from zero) to whole paise.
 * `applyPercentBp(1999n, 500)` → 100n (5% of ₹19.99 = 99.95 paise).
 */
export function applyPercentBp(
  amount: Paise,
  bp: number | bigint,
  mode: RoundingMode = 'half-up',
): Paise {
  const bpBig = toBp(bp);
  return divRound(amount * bpBig, BP_DENOMINATOR, mode);
}

export function toBp(bp: number | bigint): bigint {
  if (typeof bp === 'number' && !Number.isSafeInteger(bp)) {
    throw new TypeError('Basis points must be an integer');
  }
  return BigInt(bp);
}

/**
 * Parses a decimal percentage string to basis points: `"12.5" → 1250`. Max two decimals.
 * Throws RangeError above `maxBp` (default 10_000 = 100%) so a typo like `1000` cannot flow on.
 */
export function percentToBp(percent: string, maxBp = 10_000): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (!m) throw new SyntaxError(`Invalid percentage: ${JSON.stringify(percent)}`);
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(bp) || bp > maxBp)
    throw new RangeError(`Percentage out of range (max ${bpToPercent(maxBp)}%): ${percent}`);
  return bp;
}

/** `1250 → "12.5"`, `500 → "5"`, `250 → "2.5"`. */
export function bpToPercent(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0)
    throw new RangeError('bp must be a non-negative integer');
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Quantities are `numeric(12,3)`; arithmetic uses thousandths. `"1.5" → 1500n`. */
export function quantityToMilli(qty: string | number | bigint): bigint {
  if (typeof qty === 'bigint') return qty * 1000n;
  if (typeof qty === 'number') {
    if (!Number.isSafeInteger(qty)) throw new TypeError('Pass fractional quantities as strings');
    return BigInt(qty) * 1000n;
  }
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(qty.trim());
  if (!m) throw new SyntaxError(`Invalid quantity: ${JSON.stringify(qty)}`);
  return BigInt(m[1] ?? '0') * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
}

/** `rate × qty` in paise, with `qtyMilli` in thousandths, rounded half-up. */
export function lineAmount(ratePaise: Paise, qtyMilli: bigint): Paise {
  return divRound(ratePaise * qtyMilli, 1000n);
}

/**
 * Splits `total` across `weights` proportionally; shares sum to `total` exactly (largest-remainder,
 * ties to the earlier index). Used for bill-level discounts spread over lines.
 */
export function allocatePaise(total: Paise, weights: readonly Paise[]): Paise[] {
  if (weights.length === 0) {
    if (total !== 0n) throw new RangeError('Cannot allocate a non-zero amount to no lines');
    return [];
  }
  if (weights.some((w) => w < 0n)) throw new RangeError('weights must be non-negative');
  const weightSum = sumPaise(weights);
  if (weightSum === 0n) {
    if (total !== 0n) throw new RangeError('Cannot allocate across zero total weight');
    return weights.map(() => 0n);
  }
  const sign = total < 0n ? -1n : 1n;
  const t = abs(total);
  const shares = weights.map((w) => (t * w) / weightSum);
  const remainders = weights.map((w, i) => ({ i, r: (t * w) % weightSum }));
  let left = t - sumPaise(shares);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares.map((s) => s * sign);
}

/** Difference needed to bring `total` to the nearest whole rupee (50 paise rounds away from zero). */
export function roundOffToRupee(total: Paise): Paise {
  return divRound(total, PAISE_PER_RUPEE) * PAISE_PER_RUPEE - total;
}
