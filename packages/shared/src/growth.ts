import { daysBetween, parseIsoDate } from './dates';
import hcfaData from './who-growth/hcfa.json';
import lhfaData from './who-growth/lhfa.json';
import wfaData from './who-growth/wfa.json';
import wfhData from './who-growth/wfh.json';
import wflData from './who-growth/wfl.json';
import {
  WHO_LENGTH_UNTIL_DAYS,
  WHO_MAX_AGE_DAYS,
  type GrowthIndicator,
  type StoredZScores,
} from './paeds';

/**
 * WHO Child Growth Standards z-scores, 0 to 5 years (OPD-06, docs/11 §4.2). The LMS tables are the
 * public WHO "expanded tables" (2006 standards, by day of age, and by length / height in 0.1 cm
 * steps) bundled as JSON in `who-growth/`; nothing is typed in by hand. Not exported from the
 * package barrel: import from `@hmis/shared/growth` on the server.
 *
 *   z = ((x / M)^L − 1) / (L · S)            (L ≠ 0)        z = ln(x / M) / S    (L = 0)
 *
 * For weight-for-age and weight-for-length / height a z beyond ±3 is extended linearly from the
 * ±2 / ±3 SD points, as the WHO software does, so that a very small child is not under-reported.
 * Length / height-for-age and head circumference use the plain formula. Children 5 years and over
 * (IAP 2015 charts, not bundled yet) and patients whose sex is "other" get values without z-scores.
 */

type Sex = 'M' | 'F';

interface LmsTable {
  start: number;
  step: number;
  lms: [number, number, number][];
}
interface Source {
  boys: LmsTable;
  girls: LmsTable;
}

const SOURCES: Record<'wfa' | 'lhfa' | 'hcfa' | 'wfl' | 'wfh', Source> = {
  wfa: wfaData as unknown as Source,
  lhfa: lhfaData as unknown as Source,
  hcfa: hcfaData as unknown as Source,
  wfl: wflData as unknown as Source,
  wfh: wfhData as unknown as Source,
};

const tableFor = (key: keyof typeof SOURCES, sex: Sex): LmsTable =>
  sex === 'M' ? SOURCES[key].boys : SOURCES[key].girls;

/** L, M, S at `x` (interpolated linearly between rows); null outside the table. */
function lmsAt(t: LmsTable, x: number): [number, number, number] | null {
  const pos = (x - t.start) / t.step;
  if (!(pos >= -1e-9) || pos > t.lms.length - 1 + 1e-9) return null;
  const lo = Math.min(Math.max(Math.floor(pos + 1e-9), 0), t.lms.length - 1);
  const hi = Math.min(lo + 1, t.lms.length - 1);
  const f = Math.min(Math.max(pos - lo, 0), 1);
  const a = t.lms[lo]!;
  const b = t.lms[hi]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Value on the curve for a given z: M (1 + L S z)^(1/L). */
const valueAtZ = (l: number, m: number, s: number, z: number): number =>
  Math.abs(l) < 1e-9 ? m * Math.exp(s * z) : m * (1 + l * s * z) ** (1 / l);

function zFromLms([l, m, s]: [number, number, number], x: number, extendBeyond3: boolean): number {
  const z = Math.abs(l) < 1e-9 ? Math.log(x / m) / s : ((x / m) ** l - 1) / (l * s);
  if (!extendBeyond3 || Math.abs(z) <= 3) return z;
  if (z > 3) {
    const sd3 = valueAtZ(l, m, s, 3);
    const sd23 = sd3 - valueAtZ(l, m, s, 2);
    return 3 + (x - sd3) / sd23;
  }
  const sd3n = valueAtZ(l, m, s, -3);
  const sd23n = valueAtZ(l, m, s, -2) - sd3n;
  return -3 + (x - sd3n) / sd23n;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Which table an indicator reads at this age, and the argument on its axis. */
function axis(
  indicator: GrowthIndicator,
  ageDays: number,
  lengthHeightCm: number | null,
): { table: keyof typeof SOURCES; x: number } | null {
  switch (indicator) {
    case 'wfa':
    case 'lhfa':
    case 'hcfa':
      return { table: indicator, x: ageDays };
    case 'wfh':
      if (lengthHeightCm === null) return null;
      return { table: ageDays < WHO_LENGTH_UNTIL_DAYS ? 'wfl' : 'wfh', x: lengthHeightCm };
  }
}

/** One z-score; null when the child is out of the table's range or the argument is missing. */
export function zScore(o: {
  indicator: GrowthIndicator;
  sex: Sex;
  ageDays: number;
  value: number;
  /** For weight-for-length / height: the child's length or height (cm). */
  lengthHeightCm?: number | null;
}): number | null {
  if (!(o.value > 0) || o.ageDays < 0 || o.ageDays > WHO_MAX_AGE_DAYS) return null;
  const ax = axis(o.indicator, o.ageDays, o.lengthHeightCm ?? null);
  if (!ax) return null;
  const lms = lmsAt(tableFor(ax.table, o.sex), ax.x);
  if (!lms) return null;
  return round2(zFromLms(lms, o.value, o.indicator === 'wfa' || o.indicator === 'wfh'));
}

/** WHO flag limits for biologically implausible values (z beyond them is probably a slip). */
const IMPLAUSIBLE: Partial<Record<GrowthIndicator, [number, number]>> = {
  wfa: [-6, 5],
  lhfa: [-6, 6],
  wfh: [-5, 5],
};

export interface MeasurementInput {
  sex: 'M' | 'F' | 'O' | null;
  dob: string;
  measuredOn: string;
  weightKg: number | null;
  lengthHeightCm: number | null;
  headCircCm: number | null;
}

/** All z-scores of one visit (what `growth_measurement.z_scores` stores). */
export function computeZScores(m: MeasurementInput): StoredZScores {
  const empty: StoredZScores = {
    wfa: null,
    lhfa: null,
    hcfa: null,
    wfh: null,
    implausible: [],
    skipped: null,
  };
  const ageDays = daysBetween(parseIsoDate(m.dob), parseIsoDate(m.measuredOn));
  if (ageDays < 0 || ageDays > WHO_MAX_AGE_DAYS) return { ...empty, skipped: 'age' };
  if (m.sex !== 'M' && m.sex !== 'F') return { ...empty, skipped: 'sex' };
  const sex = m.sex;
  const out: StoredZScores = { ...empty };
  if (m.weightKg !== null) {
    out.wfa = zScore({ indicator: 'wfa', sex, ageDays, value: m.weightKg });
    out.wfh = zScore({
      indicator: 'wfh',
      sex,
      ageDays,
      value: m.weightKg,
      lengthHeightCm: m.lengthHeightCm,
    });
  }
  if (m.lengthHeightCm !== null) {
    out.lhfa = zScore({ indicator: 'lhfa', sex, ageDays, value: m.lengthHeightCm });
  }
  if (m.headCircCm !== null) {
    out.hcfa = zScore({ indicator: 'hcfa', sex, ageDays, value: m.headCircCm });
  }
  for (const [ind, [lo, hi]] of Object.entries(IMPLAUSIBLE) as [
    GrowthIndicator,
    [number, number],
  ][]) {
    const z = out[ind];
    if (z !== null && (z < lo || z > hi)) out.implausible.push(ind);
  }
  return out;
}

export const CURVE_Z_LINES = [-3, -2, 0, 2, 3] as const;

export interface GrowthCurve {
  indicator: GrowthIndicator;
  /** x axis: age in days (wfa, lhfa, hcfa) or length / height in cm (wfh). */
  xs: number[];
  /** One series per z line, same length as `xs`. */
  lines: { z: number; ys: number[] }[];
}

/**
 * Reference curves for the chart. Age-based curves are sampled every `stepDays` from 0 to 5 y;
 * weight-for-height uses the length table below 2 years and the height table from 2 years,
 * `ageDays` picking which one.
 */
export function growthCurve(o: {
  indicator: GrowthIndicator;
  sex: Sex;
  stepDays?: number;
  /** For `wfh`: the child's age, deciding between the length and the height table. */
  ageDays?: number;
}): GrowthCurve {
  const xs: number[] = [];
  const tableKey =
    o.indicator === 'wfh'
      ? (o.ageDays ?? 0) < WHO_LENGTH_UNTIL_DAYS
        ? 'wfl'
        : 'wfh'
      : o.indicator;
  const t = tableFor(tableKey, o.sex);
  const end = o.indicator === 'wfh' ? t.start + (t.lms.length - 1) * t.step : WHO_MAX_AGE_DAYS;
  const step = o.indicator === 'wfh' ? 1 : (o.stepDays ?? 30);
  for (let x = t.start; x <= end + 1e-9; x += step) xs.push(Math.round(x * 10) / 10);
  const lines = CURVE_Z_LINES.map((z) => ({
    z,
    ys: xs.map((x) => {
      const lms = lmsAt(t, x)!;
      return Math.round(valueAtZ(lms[0], lms[1], lms[2], z) * 100) / 100;
    }),
  }));
  return { indicator: o.indicator, xs, lines };
}
