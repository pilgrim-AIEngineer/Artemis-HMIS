import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { isoDateSchema, uuidSchema } from './primitives';

/**
 * Paediatric constants shared by the screens and the server (OPD-06, docs/11 §4): growth
 * indicators, z-score bands and the growth-measurement input. The WHO tables and the maths live in
 * `growth.ts` (subpath `@hmis/shared/growth`, not in this barrel: the tables are ~300 KB and the
 * browser never needs them, the server returns computed values and curves).
 */

export const GROWTH_INDICATORS = ['wfa', 'lhfa', 'hcfa', 'wfh'] as const;
export type GrowthIndicator = (typeof GROWTH_INDICATORS)[number];

/** WHO standards cover 0 to 5 years; the table ends at day 1826 (60 completed months). */
export const WHO_MAX_AGE_DAYS = 1826;
/** Under this age (days) the child is measured lying (length), from then standing (height). */
export const WHO_LENGTH_UNTIL_DAYS = 731;

export type ZBand = 'lt_neg3' | 'lt_neg2' | 'normal' | 'gt_pos2' | 'gt_pos3';
export const Z_BANDS: readonly ZBand[] = ['lt_neg3', 'lt_neg2', 'normal', 'gt_pos2', 'gt_pos3'];

/** Where a z-score sits against the usual ±2 / ±3 lines; a prompt for the doctor, not a diagnosis. */
export function zBand(z: number): ZBand {
  if (z < -3) return 'lt_neg3';
  if (z < -2) return 'lt_neg2';
  if (z > 3) return 'gt_pos3';
  if (z > 2) return 'gt_pos2';
  return 'normal';
}

/** What is stored in `growth_measurement.z_scores`. */
export interface StoredZScores {
  wfa: number | null;
  lhfa: number | null;
  hcfa: number | null;
  wfh: number | null;
  /** Indicators whose value is biologically implausible by the WHO flag limits. */
  implausible: GrowthIndicator[];
  /** Why no z-scores were computed at all (`age`, `sex`), else null. */
  skipped: 'age' | 'sex' | null;
}

/** Plausible limits for a child's measurements; wider values are typing slips and are refused. */
export const GROWTH_LIMITS = {
  weightKg: { min: 0.3, max: 200 },
  lengthHeightCm: { min: 20, max: 220 },
  headCircCm: { min: 15, max: 70 },
} as const;

const decimal = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .transform((n) => Math.round(n * 100) / 100);

export const recordGrowthSchema = z
  .object({
    idempotencyKey: z.uuid(),
    patientId: uuidSchema,
    encounterId: uuidSchema.nullable().default(null),
    measuredOn: isoDateSchema,
    weightKg: decimal(GROWTH_LIMITS.weightKg.min, GROWTH_LIMITS.weightKg.max).nullable(),
    lengthHeightCm: decimal(
      GROWTH_LIMITS.lengthHeightCm.min,
      GROWTH_LIMITS.lengthHeightCm.max,
    ).nullable(),
    headCircCm: decimal(GROWTH_LIMITS.headCircCm.min, GROWTH_LIMITS.headCircCm.max).nullable(),
  })
  .refine((v) => v.weightKg !== null || v.lengthHeightCm !== null || v.headCircCm !== null, {
    message: 'paeds.growthEmpty',
    path: ['weightKg'],
  });
export type RecordGrowthInput = z.infer<typeof recordGrowthSchema>;

// ---------------------------------------------------------------- weight-based dose check (§4.4)

export const PAEDS_RULE_FORMS = ['syp', 'drops', 'susp', 'inj', 'tab', 'cap', 'sachet'] as const;

/** A paediatrician-approved rule (`drug_paeds_rule`). Never invented in code or seed. */
export interface PaedsDoseRule {
  genericName: string;
  mgPerKgMin: number;
  mgPerKgMax: number;
  maxMgPerDose: number | null;
  maxDosesPerDay: number | null;
  /** Concentration of liquid forms (mg per ml) keyed by drug form. */
  concentrationMgPerMl: Partial<Record<string, number>>;
}

export const paedsRuleInputSchema = z
  .object({
    genericName: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .refine(...noForbiddenTerms('always')),
    mgPerKgMin: z.number().positive().max(2000),
    mgPerKgMax: z.number().positive().max(2000),
    maxMgPerDose: z.number().positive().max(20_000).nullable().default(null),
    maxDosesPerDay: z.number().int().min(1).max(24).nullable().default(null),
    concentrationMgPerMl: z
      .partialRecord(z.enum(PAEDS_RULE_FORMS), z.number().positive().max(1000))
      .default({}),
    note: z
      .string()
      .trim()
      .max(300)
      .refine(...noForbiddenTerms('always'))
      .nullable()
      .default(null),
  })
  .refine((v) => v.mgPerKgMin <= v.mgPerKgMax, {
    message: 'validation.invalid',
    path: ['mgPerKgMax'],
  });
export type PaedsRuleInput = z.infer<typeof paedsRuleInputSchema>;

/** The dose as typed on the Rx row. */
export interface TypedDose {
  amount: number;
  unit: 'ml' | 'mg' | 'unit';
}

/** Parses `5 ml`, `2.5ml`, `250 mg`, `1 tab`, `½ tab`, `0.5`; null when there is no number. */
export function parseTypedDose(text: string | null | undefined): TypedDose | null {
  if (!text) return null;
  const m =
    /^\s*(\d\/\d|\d+(?:\.\d+)?|½|¼|¾)\s*(ml|mg|tab|tabs|tablet|cap|caps|capsule|sachet|drop|drops|sac|pessary|pcs?)?\b/i.exec(
      text,
    );
  if (!m) return null;
  const raw = m[1]!;
  const amount =
    raw === '½'
      ? 0.5
      : raw === '¼'
        ? 0.25
        : raw === '¾'
          ? 0.75
          : raw.includes('/')
            ? Number(raw.split('/')[0]) / Number(raw.split('/')[1])
            : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const u = m[2]?.toLowerCase();
  if (u === 'ml') return { amount, unit: 'ml' };
  if (u === 'mg') return { amount, unit: 'mg' };
  return { amount, unit: 'unit' };
}

/** Milligrams in a strength text (`250 mg`, `125mg/5ml` → 125 per 5 ml is not a single number: null). */
export function strengthMg(strength: string | null | undefined): number | null {
  if (!strength) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*mg\s*$/i.exec(strength);
  return m ? Number(m[1]) : null;
}

export type PaedsDoseVerdict =
  'within' | 'below' | 'above' | 'over_max_dose' | 'too_many_doses' | 'cannot_check';

export interface PaedsDoseCheck {
  verdict: PaedsDoseVerdict;
  weightKg: number;
  /** Per dose, in mg. */
  expectedMgMin: number;
  expectedMgMax: number;
  /** Per dose in the unit typed (ml for liquids, units for solids); null when not convertible. */
  expectedMin: number | null;
  expectedMax: number | null;
  unit: 'ml' | 'mg' | 'unit';
  enteredMg: number | null;
}

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Weight-based range for one dose (docs/11 §4.4): `mg/kg × weight`, capped by the rule's maximum
 * per dose, shown in the unit the assistant typed ("Expected 4.5–6.0 ml per dose for 14 kg").
 * Amber warning only when outside; the dose is never changed. `cannot_check` when the typed unit
 * cannot be turned into mg (a liquid without a concentration, a tablet without a strength).
 */
export function checkPaedsDose(o: {
  rule: PaedsDoseRule;
  weightKg: number;
  dose: TypedDose;
  /** Drug form of the row (`syp`, `tab`, …) for the concentration. */
  form: string | null;
  /** mg in one tablet / capsule / sachet (from the drug's strength). */
  mgPerUnit: number | null;
  dosesPerDay: number | null;
}): PaedsDoseCheck {
  const { rule, weightKg, dose } = o;
  let expectedMgMin = rule.mgPerKgMin * weightKg;
  let expectedMgMax = rule.mgPerKgMax * weightKg;
  if (rule.maxMgPerDose !== null) {
    expectedMgMin = Math.min(expectedMgMin, rule.maxMgPerDose);
    expectedMgMax = Math.min(expectedMgMax, rule.maxMgPerDose);
  }
  const conc = o.form ? (rule.concentrationMgPerMl[o.form] ?? null) : null;
  let mgPerAmount: number | null = null; // mg in one `dose.unit`
  if (dose.unit === 'mg') mgPerAmount = 1;
  else if (dose.unit === 'ml') mgPerAmount = conc;
  else mgPerAmount = o.mgPerUnit;
  const base = {
    weightKg,
    expectedMgMin: round(expectedMgMin, 1),
    expectedMgMax: round(expectedMgMax, 1),
    unit: dose.unit,
  };
  if (mgPerAmount === null) {
    return {
      ...base,
      verdict: 'cannot_check',
      expectedMin: null,
      expectedMax: null,
      enteredMg: null,
    };
  }
  const enteredMg = dose.amount * mgPerAmount;
  const expectedMin = round(expectedMgMin / mgPerAmount, 1);
  const expectedMax = round(expectedMgMax / mgPerAmount, 1);
  const eps = 1e-6;
  // A dose outside the range is reported before too many doses a day.
  let verdict: PaedsDoseVerdict = 'within';
  if (rule.maxMgPerDose !== null && enteredMg > rule.maxMgPerDose + eps) verdict = 'over_max_dose';
  else if (enteredMg > expectedMgMax + eps) verdict = 'above';
  else if (enteredMg < expectedMgMin - eps) verdict = 'below';
  else if (
    rule.maxDosesPerDay !== null &&
    o.dosesPerDay !== null &&
    o.dosesPerDay > rule.maxDosesPerDay
  ) {
    verdict = 'too_many_doses';
  }
  return { ...base, verdict, expectedMin, expectedMax, enteredMg: round(enteredMg, 1) };
}

export const PAEDS_WARNING_VERDICTS: readonly PaedsDoseVerdict[] = [
  'below',
  'above',
  'over_max_dose',
  'too_many_doses',
];

// ---------------------------------------------------------------- consent and the message outbox

export const CONSENT_KINDS = ['whatsapp', 'data_processing', 'abdm_share'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_METHODS = ['verbal_recorded', 'signed', 'otp'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** `cancelled` is added to docs/04 §13: a queued reminder replaced when the schedule moves. */
export const MESSAGE_OUTBOX_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'opted_out',
  'skipped_no_consent',
  'cancelled',
] as const;
export type MessageOutboxStatus = (typeof MESSAGE_OUTBOX_STATUSES)[number];
