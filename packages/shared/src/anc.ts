import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { addDays, daysBetween, formatDate, parseIsoDate, toIsoDate } from './dates';
import { isoDateSchema, uuidSchema } from './primitives';

/**
 * ANC card calculators (OPD-05, docs/11 §3). Pure functions over `YYYY-MM-DD` strings and whole
 * days, so leap years and month ends are plain calendar arithmetic and nothing depends on the
 * machine's time zone. The software calculates and reminds; it never decides treatment, and every
 * threshold here is a default that the owner gynaecologist confirms (settings `anc.*`, build plan
 * "pending sign-off"). Nothing in this file describes the fetus beyond the number of babies, the
 * heart rate and the fundal height of the routine antenatal examination (AGENTS.md rule 7).
 */

export const PREGNANCY_STATUSES = [
  'active',
  'delivered',
  'aborted',
  'mtp',
  'ectopic',
  'lost_to_follow_up',
  'transferred',
] as const;
export type PregnancyStatus = (typeof PREGNANCY_STATUSES)[number];

/** Outcomes that close a pregnancy (everything but `active`). */
export const PREGNANCY_CLOSE_OUTCOMES = [
  'delivered',
  'aborted',
  'mtp',
  'ectopic',
  'lost_to_follow_up',
  'transferred',
] as const satisfies readonly PregnancyStatus[];

/**
 * What a user without MTP permission sees for a closed pregnancy (docs/11 §3.1): the MTP outcome
 * reads as plain "Closed" and carries no reason or date.
 */
export const MASKED_PREGNANCY_STATUS = 'closed' as const;

/** Outcome of an earlier pregnancy. MTP is deliberately absent: it lives in the restricted register (docs/14). */
export const OB_OUTCOMES = [
  'nvd',
  'lscs',
  'assisted',
  'abortion',
  'ectopic',
  'stillbirth',
] as const;
export type ObOutcome = (typeof OB_OUTCOMES)[number];

export const DATING_BASES = ['lmp', 'scan'] as const;
export type DatingBasis = (typeof DATING_BASES)[number];

export const PLURALITIES = ['single', 'twins', 'higher'] as const;
export type Plurality = (typeof PLURALITIES)[number];

export const PRESENTATIONS = [
  'cephalic',
  'breech',
  'transverse',
  'oblique',
  'not_assessed',
] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

export const ANC_SCHEDULE_KINDS = ['visit', 'test', 'scan', 'vaccine', 'supplement'] as const;
export type AncScheduleKind = (typeof ANC_SCHEDULE_KINDS)[number];

export const ANC_SCHEDULE_STATUSES = ['due', 'done', 'skipped'] as const;

/** Display states of a schedule item for one pregnancy (docs/11 §3.4 adds `upcoming` and `not_applicable`). */
export type AncItemState = 'upcoming' | 'due' | 'overdue' | 'done' | 'skipped' | 'not_applicable';

export const GESTATION_DAYS = 280;
const DAYS_PER_WEEK = 7;

/** A pregnancy older than this many days from LMP is not an ongoing pregnancy (44 weeks). */
export const MAX_ONGOING_GA_DAYS = 308;

// ---------------------------------------------------------------- dates and gestational age

export interface GestationalAge {
  weeks: number;
  days: number;
}

/** `{ weeks, days }` from a number of days (negative → 0w 0d). */
export function splitGa(totalDays: number): GestationalAge {
  const d = Math.max(0, Math.trunc(totalDays));
  return { weeks: Math.floor(d / DAYS_PER_WEEK), days: d % DAYS_PER_WEEK };
}

export const gaToDays = (weeks: number, days: number): number => weeks * DAYS_PER_WEEK + days;

/** `24w 3d` (docs/10 §8). */
export function formatGa(totalDays: number): string {
  const { weeks, days } = splitGa(totalDays);
  return `${weeks}w ${days}d`;
}

/** Naegele's rule as used by the spec: EDD = LMP + 280 days (docs/11 §3.1). */
export function eddFromLmp(lmp: string): string {
  return toIsoDate(addDays(parseIsoDate(lmp), GESTATION_DAYS));
}

/** The LMP that a given EDD implies (used to show "dated as" for scan-dated pregnancies). */
export function lmpFromEdd(edd: string): string {
  return toIsoDate(addDays(parseIsoDate(edd), -GESTATION_DAYS));
}

/** EDD from a scan: the scan date plus the days still to go at the GA found on that date. */
export function eddFromScan(scanDate: string, gaAtScanDays: number): string {
  return toIsoDate(addDays(parseIsoDate(scanDate), GESTATION_DAYS - gaAtScanDays));
}

/** Gestational age in days on `on`, counted back from an EDD (negative before conception). */
export function gaDaysOnDate(edd: string, on: string): number {
  return GESTATION_DAYS - daysBetween(parseIsoDate(on), parseIsoDate(edd));
}

/** Gestational age in days on `on`, counted from the LMP. */
export function gaDaysFromLmp(lmp: string, on: string): number {
  return daysBetween(parseIsoDate(lmp), parseIsoDate(on));
}

/** Trimester of a GA in days: 1st to 13w6d, 2nd to 27w6d, 3rd after that. */
export function trimesterOf(gaDays: number): 1 | 2 | 3 {
  return gaDays < 14 * DAYS_PER_WEEK ? 1 : gaDays < 28 * DAYS_PER_WEEK ? 2 : 3;
}

export interface LmpCheck {
  ok: boolean;
  /** i18n key under `errors.` when not ok. */
  error?: 'anc.lmpFuture' | 'anc.lmpTooOld' | 'anc.dateInvalid';
}

/** An ongoing pregnancy needs an LMP that is not in the future and not more than 44 weeks back. */
export function checkLmp(lmp: string, today: string): LmpCheck {
  let l;
  let t;
  try {
    l = parseIsoDate(lmp);
    t = parseIsoDate(today);
  } catch {
    return { ok: false, error: 'anc.dateInvalid' };
  }
  const ga = daysBetween(l, t);
  if (ga < 0) return { ok: false, error: 'anc.lmpFuture' };
  if (ga > MAX_ONGOING_GA_DAYS) return { ok: false, error: 'anc.lmpTooOld' };
  return { ok: true };
}

// ---------------------------------------------------------------- scan re-dating

/**
 * One row of the re-dating table: from this GA (days, at the scan) the dating is questioned when
 * the scan and LMP EDDs differ by MORE than `thresholdDays`.
 */
export const redatingRowSchema = z.object({
  fromDays: z.number().int().min(0).max(400),
  thresholdDays: z.number().int().min(0).max(60),
});

export const redatingTableSchema = z
  .array(redatingRowSchema)
  .min(1)
  .max(12)
  .refine(
    (rows) =>
      rows.length > 0 &&
      rows[0]!.fromDays === 0 &&
      rows.every((r, i) => i === 0 || r.fromDays > rows[i - 1]!.fromDays),
    'validation.invalid',
  );
export type RedatingTable = z.infer<typeof redatingTableSchema>;

/** Defaults (ACOG-style, docs/11 §3.1), pending gynaecologist sign-off. */
export const DEFAULT_REDATING_TABLE: RedatingTable = [
  { fromDays: 0, thresholdDays: 5 }, // < 9w0d
  { fromDays: gaToDays(9, 0), thresholdDays: 7 }, // 9w0d – 13w6d
  { fromDays: gaToDays(14, 0), thresholdDays: 7 }, // 14w0d – 15w6d
  { fromDays: gaToDays(16, 0), thresholdDays: 10 }, // 16w0d – 21w6d
  { fromDays: gaToDays(22, 0), thresholdDays: 14 }, // 22w0d – 27w6d
  { fromDays: gaToDays(28, 0), thresholdDays: 21 }, // 28w0d and later
];

/** The threshold (days) that applies to a scan done at `gaAtScanDays`. */
export function redatingThreshold(
  gaAtScanDays: number,
  table: RedatingTable = DEFAULT_REDATING_TABLE,
): number {
  let t = table[0]!.thresholdDays;
  for (const row of table) if (gaAtScanDays >= row.fromDays) t = row.thresholdDays;
  return t;
}

export interface RedatingAssessment {
  eddByLmp: string;
  eddByScan: string;
  /** GA on the scan date by the LMP, in days. */
  gaByLmpAtScan: number;
  /** Scan EDD minus LMP EDD: positive when the scan puts the delivery later than the LMP does. */
  differenceDays: number;
  thresholdDays: number;
  /** The difference is strictly more than the threshold: suggest switching `edd_final` to the scan EDD. */
  suggestScan: boolean;
}

/**
 * Compares the LMP dating with a dating scan (docs/11 §3.1). The software only suggests; the
 * assistant or doctor confirms, and the change is audited. A difference equal to the threshold
 * keeps the LMP ("more than").
 */
export function assessRedating(input: {
  lmp: string;
  scanDate: string;
  gaAtScanDays: number;
  table?: RedatingTable;
}): RedatingAssessment {
  const eddByLmp = eddFromLmp(input.lmp);
  const eddByScan = eddFromScan(input.scanDate, input.gaAtScanDays);
  const differenceDays = daysBetween(parseIsoDate(eddByLmp), parseIsoDate(eddByScan));
  // The row is picked by the GA found at the scan (the scan's own GA, not the LMP's).
  const thresholdDays = redatingThreshold(input.gaAtScanDays, input.table);
  return {
    eddByLmp,
    eddByScan,
    gaByLmpAtScan: gaDaysFromLmp(input.lmp, input.scanDate),
    differenceDays,
    thresholdDays,
    suggestScan: Math.abs(differenceDays) > thresholdDays,
  };
}

/** Longest GA a dating scan may report (42 weeks); the shortest worth recording is 5 weeks. */
export const MIN_SCAN_GA_DAYS = gaToDays(5, 0);
export const MAX_SCAN_GA_DAYS = gaToDays(42, 0);

export const gaInputSchema = z
  .object({ weeks: z.number().int().min(0).max(45), days: z.number().int().min(0).max(6) })
  .transform((g) => gaToDays(g.weeks, g.days))
  .refine((d) => d >= MIN_SCAN_GA_DAYS && d <= MAX_SCAN_GA_DAYS, 'anc.scanGaRange');

// ---------------------------------------------------------------- GPAL

export interface ObHistoryEntry {
  outcome: ObOutcome;
  gestationWeeks: number | null;
  /** Babies from this pregnancy alive today (twins can be 2). */
  babiesAlive: number;
}

export const DEFAULT_VIABILITY_WEEKS = 28;

export interface Gpal {
  g: number;
  p: number;
  a: number;
  l: number;
}

/**
 * Gravida / para / abortions / living (docs/11 §3.1) from earlier pregnancies plus the current
 * one. `viabilityWeeks` (setting `anc.viabilityWeeks`, default 28) separates a birth (para) from an
 * abortion when the gestation is recorded; a delivery with no recorded gestation counts as para
 * and an `abortion` or `ectopic` as an abortion whatever the gestation. A stillbirth is a birth.
 */
export function computeGpal(
  history: readonly ObHistoryEntry[],
  viabilityWeeks = DEFAULT_VIABILITY_WEEKS,
): Gpal {
  let p = 0;
  let a = 0;
  let l = 0;
  for (const h of history) {
    l += Math.max(0, h.babiesAlive);
    if (h.outcome === 'abortion' || h.outcome === 'ectopic') {
      a += 1;
    } else if (h.gestationWeeks !== null && h.gestationWeeks < viabilityWeeks) {
      a += 1;
    } else {
      p += 1;
    }
  }
  return { g: history.length + 1, p, a, l };
}

/** `G3 P1 A1 L1`. */
export const formatGpal = (g: Gpal): string => `G${g.g} P${g.p} A${g.a} L${g.l}`;

/** A hand-edited score must still add up: births plus abortions cannot exceed the earlier pregnancies (G - 1). */
export function gpalConsistent(g: Gpal): boolean {
  return g.g >= 1 && g.p >= 0 && g.a >= 0 && g.l >= 0 && g.p + g.a <= g.g - 1;
}

// ---------------------------------------------------------------- risk flags

export const AUTO_RISK_CODES = [
  'age_young',
  'age_elderly',
  'short_stature',
  'obese_at_booking',
  'raised_bp',
  'severe_raised_bp',
  'anaemia',
  'severe_anaemia',
  'previous_lscs',
  'previous_stillbirth_or_neonatal_death',
  'recurrent_abortions',
  'grand_multipara',
  'rh_negative',
  'multiple_pregnancy',
  'post_dates',
] as const;
export type AutoRiskCode = (typeof AUTO_RISK_CODES)[number];

/** Manual flags the doctor or assistant ticks (docs/11 §3.2); `other` carries free text. */
export const MANUAL_RISK_CODES = [
  'gdm',
  'thyroid_disorder',
  'heart_disease',
  'placenta_praevia',
  'iugr',
  'other',
] as const;
export type ManualRiskCode = (typeof MANUAL_RISK_CODES)[number];

export type RiskCode = AutoRiskCode | ManualRiskCode;
export type RiskLevel = 'warn' | 'alert';

export interface RiskFlag {
  code: RiskCode;
  level: RiskLevel;
  source: 'auto' | 'manual';
  /** Free text of an `other` flag; never part of an auto flag. */
  text?: string;
  /** The number behind an auto flag (age, BP, Hb, …), for display. */
  value?: string;
}

export const riskRulesSchema = z.object({
  ageBelow: z.number().int().min(10).max(25),
  ageAbove: z.number().int().min(30).max(50),
  heightBelowCm: z.number().min(100).max(170),
  bmiAtLeast: z.number().min(20).max(50),
  bpSysAtLeast: z.number().int().min(100).max(200),
  bpDiaAtLeast: z.number().int().min(60).max(130),
  severeBpSysAtLeast: z.number().int().min(120).max(260),
  severeBpDiaAtLeast: z.number().int().min(80).max(160),
  hbBelow: z.number().min(5).max(15),
  hbSevereBelow: z.number().min(2).max(10),
  abortionsAtLeast: z.number().int().min(1).max(10),
  paraAtLeast: z.number().int().min(2).max(15),
  postDatesAfterDays: z.number().int().min(280).max(300),
});
export type RiskRules = z.infer<typeof riskRulesSchema>;

/** Default auto rules (docs/11 §3.2), pending gynaecologist sign-off. */
export const DEFAULT_RISK_RULES: RiskRules = {
  ageBelow: 18,
  ageAbove: 35,
  heightBelowCm: 145,
  bmiAtLeast: 30,
  bpSysAtLeast: 140,
  bpDiaAtLeast: 90,
  severeBpSysAtLeast: 160,
  severeBpDiaAtLeast: 110,
  hbBelow: 11,
  hbSevereBelow: 7,
  abortionsAtLeast: 2,
  paraAtLeast: 4,
  postDatesAfterDays: 280, // "GA > 40w": 40w 0d is day 280, so flagged from 40w 1d
};

export interface RiskInput {
  ageYears: number | null;
  heightCm: number | null;
  /** BMI at the booking visit. */
  bookingBmi: number | null;
  /** BP of every visit, newest or oldest first (order does not matter). */
  bps: readonly { sys: number | null; dia: number | null }[];
  /** Haemoglobin of every visit (g/dL); the lowest counts. */
  hbs: readonly (number | null)[];
  gpal: Gpal;
  history: readonly { outcome: ObOutcome; neonatalDeath: boolean }[];
  /** `A+`, `O-`, … or null when not known. */
  bloodGroupRh: string | null;
  plurality: Plurality;
  /** GA today in days (null when unknown). */
  gaDays: number | null;
  manual: readonly { code: ManualRiskCode; text?: string }[];
}

/** True for a blood group written with a negative Rh (`B-`, `AB neg`, `O negative`). */
export function isRhNegative(bloodGroupRh: string | null): boolean {
  if (!bloodGroupRh) return false;
  const s = bloodGroupRh.trim().toLowerCase();
  return /[-−]$/.test(s) || /\bneg(ative)?$/.test(s);
}

/**
 * Auto + manual risk flags for display on every ANC screen and the OPD sheet (docs/11 §3.2).
 * Auto flags are recomputed from the record every time, so they clear when the data is corrected;
 * manual ones are kept until a person removes them. An `alert` flag is the more serious band.
 */
export function evaluateRisks(input: RiskInput, rules: RiskRules = DEFAULT_RISK_RULES): RiskFlag[] {
  const out: RiskFlag[] = [];
  const auto = (code: AutoRiskCode, level: RiskLevel, value?: string) =>
    out.push({ code, level, source: 'auto', ...(value ? { value } : {}) });

  if (input.ageYears !== null) {
    if (input.ageYears < rules.ageBelow) auto('age_young', 'warn', String(input.ageYears));
    if (input.ageYears > rules.ageAbove) auto('age_elderly', 'warn', String(input.ageYears));
  }
  if (input.heightCm !== null && input.heightCm < rules.heightBelowCm) {
    auto('short_stature', 'warn', String(input.heightCm));
  }
  if (input.bookingBmi !== null && input.bookingBmi >= rules.bmiAtLeast) {
    auto('obese_at_booking', 'warn', String(input.bookingBmi));
  }

  // BP at any visit: the highest reading decides, either number reaching the band counts.
  let worst: { sys: number | null; dia: number | null } | null = null;
  let level: RiskLevel | null = null;
  for (const bp of input.bps) {
    const sys = bp.sys ?? 0;
    const dia = bp.dia ?? 0;
    const severe = sys >= rules.severeBpSysAtLeast || dia >= rules.severeBpDiaAtLeast;
    const raised = sys >= rules.bpSysAtLeast || dia >= rules.bpDiaAtLeast;
    const l: RiskLevel | null = severe ? 'alert' : raised ? 'warn' : null;
    if (l && (level === null || (l === 'alert' && level === 'warn'))) {
      level = l;
      worst = bp;
    }
  }
  if (level && worst) {
    auto(level === 'alert' ? 'severe_raised_bp' : 'raised_bp', level, `${worst.sys}/${worst.dia}`);
  }

  const hbs = input.hbs.filter((h): h is number => h !== null);
  if (hbs.length > 0) {
    const lowest = Math.min(...hbs);
    if (lowest < rules.hbSevereBelow) auto('severe_anaemia', 'alert', String(lowest));
    else if (lowest < rules.hbBelow) auto('anaemia', 'warn', String(lowest));
  }

  if (input.history.some((h) => h.outcome === 'lscs')) auto('previous_lscs', 'warn');
  if (input.history.some((h) => h.outcome === 'stillbirth' || h.neonatalDeath)) {
    auto('previous_stillbirth_or_neonatal_death', 'warn');
  }
  if (input.gpal.a >= rules.abortionsAtLeast)
    auto('recurrent_abortions', 'warn', String(input.gpal.a));
  if (input.gpal.p >= rules.paraAtLeast) auto('grand_multipara', 'warn', String(input.gpal.p));
  if (isRhNegative(input.bloodGroupRh))
    auto('rh_negative', 'warn', input.bloodGroupRh ?? undefined);
  if (input.plurality !== 'single') auto('multiple_pregnancy', 'warn');
  if (input.gaDays !== null && input.gaDays > rules.postDatesAfterDays) auto('post_dates', 'alert');

  for (const m of input.manual) {
    out.push({
      code: m.code,
      level: 'warn',
      source: 'manual',
      ...(m.code === 'other' && m.text ? { text: m.text } : {}),
    });
  }
  return out;
}

/** True when any flag is raised: the patient then carries the `high_risk_pregnancy` alert. */
export const isHighRisk = (flags: readonly RiskFlag[]): boolean => flags.length > 0;

// ---------------------------------------------------------------- schedule

export interface AncScheduleDef {
  code: string;
  label: string;
  labelHi: string;
  kind: AncScheduleKind;
  /** GA window in days; `to` null = open ended. Ignored for `atBooking` items. */
  gaFromDays: number;
  gaToDays: number | null;
  /** Due from the booking visit and overdue `bookingGraceDays` later. */
  atBooking: boolean;
  /** Only for Rh-negative women. */
  rhNegativeOnly: boolean;
  /** Becomes due this many days after another item was done (Td-2 after Td-1). */
  afterCode: string | null;
  afterDays: number;
  /** Billing / order service codes whose completed order marks the item done. */
  serviceCodes: string[];
  sortOrder: number;
}

const w = gaToDays;
const def = (
  d: Partial<AncScheduleDef> &
    Pick<AncScheduleDef, 'code' | 'label' | 'labelHi' | 'kind' | 'sortOrder'>,
): AncScheduleDef => ({
  gaFromDays: 0,
  gaToDays: null,
  atBooking: false,
  rhNegativeOnly: false,
  afterCode: null,
  afterDays: 0,
  serviceCodes: [],
  ...d,
});

/**
 * The draft schedule of docs/33 §4 (gynaecologist to confirm). Windows written as a single week
 * in the draft ("28w") get a three-week window; "up to 13w6d" starts at 0. `serviceCodes` map to
 * the seed service codes so a completed order ticks the item by itself.
 */
export const DEFAULT_ANC_SCHEDULE: readonly AncScheduleDef[] = [
  def({
    code: 'booking_visit',
    label: 'Booking visit',
    labelHi: 'बुकिंग विज़िट',
    kind: 'visit',
    atBooking: true,
    sortOrder: 10,
  }),
  def({
    code: 'blood_group_rh',
    label: 'Blood group & Rh',
    labelHi: 'ब्लड ग्रुप और आरएच',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-ABO-RH'],
    sortOrder: 20,
  }),
  def({
    code: 'cbc_hb',
    label: 'CBC / Hb',
    labelHi: 'सीबीसी / हीमोग्लोबिन',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-CBC', 'LAB-HB'],
    sortOrder: 30,
  }),
  def({
    code: 'hiv',
    label: 'HIV',
    labelHi: 'एचआईवी',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-HIV'],
    sortOrder: 40,
  }),
  def({
    code: 'hbsag',
    label: 'HBsAg',
    labelHi: 'एचबीएसएजी',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-HBSAG'],
    sortOrder: 50,
  }),
  def({
    code: 'vdrl',
    label: 'VDRL / RPR',
    labelHi: 'वीडीआरएल / आरपीआर',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-VDRL'],
    sortOrder: 60,
  }),
  def({
    code: 'urine_rm',
    label: 'Urine R/M',
    labelHi: 'यूरिन आर/एम',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-URINE-RM'],
    sortOrder: 70,
  }),
  def({
    code: 'rbs_ogtt',
    label: 'RBS or OGTT (as per doctor)',
    labelHi: 'आरबीएस या ओजीटीटी (डॉक्टर के अनुसार)',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-RBS', 'LAB-OGTT'],
    sortOrder: 80,
  }),
  def({
    code: 'tsh',
    label: 'TSH',
    labelHi: 'टीएसएच',
    kind: 'test',
    atBooking: true,
    serviceCodes: ['LAB-TSH'],
    sortOrder: 90,
  }),
  def({
    code: 'dating_scan',
    label: 'Dating scan',
    labelHi: 'डेटिंग स्कैन',
    kind: 'scan',
    gaFromDays: 0,
    gaToDays: w(13, 6),
    serviceCodes: ['USG-OB-EARLY'],
    sortOrder: 100,
  }),
  def({
    code: 'nt_scan',
    label: 'NT/NB scan',
    labelHi: 'एनटी/एनबी स्कैन',
    kind: 'scan',
    gaFromDays: w(11, 0),
    gaToDays: w(13, 6),
    serviceCodes: ['USG-NT'],
    sortOrder: 110,
  }),
  def({
    code: 'anomaly_scan',
    label: 'Anomaly scan (level II)',
    labelHi: 'एनोमली स्कैन (लेवल II)',
    kind: 'scan',
    gaFromDays: w(18, 0),
    gaToDays: w(22, 0),
    serviceCodes: ['USG-ANOMALY'],
    sortOrder: 120,
  }),
  def({
    code: 'ogtt_repeat',
    label: 'OGTT (repeat)',
    labelHi: 'ओजीटीटी (दोबारा)',
    kind: 'test',
    gaFromDays: w(24, 0),
    gaToDays: w(28, 0),
    serviceCodes: ['LAB-OGTT'],
    sortOrder: 130,
  }),
  def({
    code: 'hb_repeat_1',
    label: 'Hb repeat (26–30 weeks)',
    labelHi: 'हीमोग्लोबिन दोबारा (26–30 सप्ताह)',
    kind: 'test',
    gaFromDays: w(26, 0),
    gaToDays: w(30, 0),
    serviceCodes: ['LAB-CBC', 'LAB-HB'],
    sortOrder: 140,
  }),
  def({
    code: 'hb_repeat_2',
    label: 'Hb repeat (34–36 weeks)',
    labelHi: 'हीमोग्लोबिन दोबारा (34–36 सप्ताह)',
    kind: 'test',
    gaFromDays: w(34, 0),
    gaToDays: w(36, 0),
    serviceCodes: ['LAB-CBC', 'LAB-HB'],
    sortOrder: 150,
  }),
  def({
    code: 'coombs_anti_d',
    label: 'Indirect Coombs / anti-D (Rh-negative)',
    labelHi: 'इंडायरेक्ट कूम्ब्स / एंटी-डी (आरएच नेगेटिव)',
    kind: 'test',
    gaFromDays: w(28, 0),
    gaToDays: w(31, 6),
    rhNegativeOnly: true,
    sortOrder: 160,
  }),
  def({
    code: 'growth_scan',
    label: 'Growth scan',
    labelHi: 'ग्रोथ स्कैन',
    kind: 'scan',
    gaFromDays: w(32, 0),
    gaToDays: w(36, 0),
    serviceCodes: ['USG-GROWTH'],
    sortOrder: 170,
  }),
  def({
    code: 'td_1',
    label: 'Td-1 (or booster, per history)',
    labelHi: 'टीडी-1 (या बूस्टर, इतिहास के अनुसार)',
    kind: 'vaccine',
    atBooking: true,
    sortOrder: 180,
  }),
  def({
    code: 'td_2',
    label: 'Td-2 (4 weeks after Td-1)',
    labelHi: 'टीडी-2 (टीडी-1 के 4 सप्ताह बाद)',
    kind: 'vaccine',
    afterCode: 'td_1',
    afterDays: 28,
    sortOrder: 190,
  }),
  def({
    code: 'iron_folic',
    label: 'Iron-folic acid (per doctor)',
    labelHi: 'आयरन-फोलिक एसिड (डॉक्टर के अनुसार)',
    kind: 'supplement',
    gaFromDays: w(14, 0),
    sortOrder: 200,
  }),
  def({
    code: 'calcium',
    label: 'Calcium (per doctor)',
    labelHi: 'कैल्शियम (डॉक्टर के अनुसार)',
    kind: 'supplement',
    gaFromDays: w(14, 0),
    sortOrder: 210,
  }),
];

export const DEFAULT_BOOKING_GRACE_DAYS = 14;

export interface ScheduleContext {
  /** GA today in days. */
  gaDays: number;
  today: string;
  bookingDate: string;
  rhNegative: boolean;
  bookingGraceDays?: number;
}

export interface ScheduleMark {
  status: 'due' | 'done' | 'skipped';
  doneDate: string | null;
}

export interface ScheduleItemView {
  def: AncScheduleDef;
  state: AncItemState;
  doneDate: string | null;
  /** Calendar window `from` – `to` of the item (null `to` = open ended). */
  windowFrom: string | null;
  windowTo: string | null;
}

/**
 * State of every schedule item for one pregnancy (docs/11 §3.4). `done`/`skipped` come from the
 * stored marks; otherwise the item is `upcoming` before its window, `due` inside it and `overdue`
 * after it. `atBooking` items run from the booking date for the grace days; Td-2 runs from Td-1's
 * done date plus its offset.
 */
export function scheduleStates(
  defs: readonly AncScheduleDef[],
  marks: ReadonlyMap<string, ScheduleMark>,
  ctx: ScheduleContext,
  edd: string,
): ScheduleItemView[] {
  const grace = ctx.bookingGraceDays ?? DEFAULT_BOOKING_GRACE_DAYS;
  const today = parseIsoDate(ctx.today);
  const eddDate = parseIsoDate(edd);
  const dayOfGa = (g: number) => toIsoDate(addDays(eddDate, g - GESTATION_DAYS));
  return [...defs]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d): ScheduleItemView => {
      const mark = marks.get(d.code);
      let from: string | null = null;
      let to: string | null = null;
      if (d.atBooking) {
        from = ctx.bookingDate;
        to = toIsoDate(addDays(parseIsoDate(ctx.bookingDate), grace));
      } else if (d.afterCode) {
        const base = marks.get(d.afterCode)?.doneDate ?? null;
        if (base) {
          from = toIsoDate(addDays(parseIsoDate(base), d.afterDays));
          to = toIsoDate(addDays(parseIsoDate(from), grace));
        }
      } else {
        from = dayOfGa(d.gaFromDays);
        to = d.gaToDays === null ? null : dayOfGa(d.gaToDays);
      }
      const view = (state: AncItemState): ScheduleItemView => ({
        def: d,
        state,
        doneDate: mark?.doneDate ?? null,
        windowFrom: from,
        windowTo: to,
      });
      if (d.rhNegativeOnly && !ctx.rhNegative) return view('not_applicable');
      if (mark?.status === 'done') return view('done');
      if (mark?.status === 'skipped') return view('skipped');
      if (from === null) return view('upcoming');
      if (daysBetween(today, parseIsoDate(from)) > 0) return view('upcoming');
      if (to !== null && daysBetween(parseIsoDate(to), today) > 0) return view('overdue');
      return view('due');
    });
}

/** Visit interval by GA: `uptoDays` inclusive, null = no upper limit. */
export const visitIntervalsSchema = z
  .array(
    z.object({
      uptoDays: z.number().int().min(1).max(400).nullable(),
      everyDays: z.number().int().min(1).max(60),
    }),
  )
  .min(1)
  .max(6)
  .refine(
    (rows) =>
      rows.every((r, i) =>
        i === rows.length - 1
          ? r.uptoDays === null
          : r.uptoDays !== null && (i === 0 || r.uptoDays > (rows[i - 1]!.uptoDays ?? 0)),
      ),
    'validation.invalid',
  );
export type VisitIntervals = z.infer<typeof visitIntervalsSchema>;

/** docs/11 §3.4: ≤ 28w every 4 weeks, 28–36w every 2 weeks, after 36w weekly. */
export const DEFAULT_VISIT_INTERVALS: VisitIntervals = [
  { uptoDays: w(28, 0), everyDays: 28 },
  { uptoDays: w(36, 0), everyDays: 14 },
  { uptoDays: null, everyDays: 7 },
];

export function visitIntervalDays(
  gaDays: number,
  intervals: VisitIntervals = DEFAULT_VISIT_INTERVALS,
): number {
  for (const r of intervals) if (r.uptoDays === null || gaDays <= r.uptoDays) return r.everyDays;
  return intervals[intervals.length - 1]!.everyDays;
}

export interface NextVisit {
  date: string;
  intervalDays: number;
  gaAtDate: number;
  /** The suggested date is before today: the woman is late for it. */
  overdue: boolean;
}

/** Next visit = the last visit plus the interval of its GA (docs/11 §3.4); booking date when none yet. */
export function nextVisit(input: {
  lastVisitDate: string;
  gaAtLastVisit: number;
  edd: string;
  today: string;
  intervals?: VisitIntervals;
}): NextVisit {
  const intervalDays = visitIntervalDays(input.gaAtLastVisit, input.intervals);
  const date = toIsoDate(addDays(parseIsoDate(input.lastVisitDate), intervalDays));
  return {
    date,
    intervalDays,
    gaAtDate: gaDaysOnDate(input.edd, date),
    overdue: daysBetween(parseIsoDate(input.today), parseIsoDate(date)) < 0,
  };
}

// ---------------------------------------------------------------- inputs

/** Free text of the ANC card: strict forbidden-term guard (AGENTS.md rule 7, D-10), blank → null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(...noForbiddenTerms('strict'))
    .transform((s) => (s === '' ? null : s))
    .nullish()
    .transform((s) => s ?? null);

const obHistoryEntrySchema = z.object({
  year: z.number().int().min(1950).max(2100).nullable(),
  outcome: z.enum(OB_OUTCOMES),
  gestationWeeks: z.number().int().min(4).max(45).nullable(),
  place: optionalText(120),
  complications: optionalText(300),
  babiesAlive: z.number().int().min(0).max(4),
  neonatalDeath: z.boolean(),
});
export type ObHistoryInput = z.infer<typeof obHistoryEntrySchema>;

export const bloodGroupRhSchema = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);

export const manualRiskSchema = z.object({
  code: z.enum(MANUAL_RISK_CODES),
  text: optionalText(200),
});

/** Opening a pregnancy record: LMP (date) or, with the LMP unknown, the GA found by a scan (docs/11 §3.1). */
export const createPregnancySchema = z
  .object({
    patientId: uuidSchema,
    idempotencyKey: z.uuid(),
    /** Null = LMP unknown; then `scan` must give the dating. */
    lmp: isoDateSchema.nullable(),
    scan: z.object({ date: isoDateSchema, ga: gaInputSchema }).nullable().default(null),
    bloodGroupRh: bloodGroupRhSchema.nullable().default(null),
    plurality: z.enum(PLURALITIES).default('single'),
    /** Omitted = keep the history already on record; given = replaces it. */
    history: z.array(obHistoryEntrySchema).max(20).optional(),
    notes: optionalText(500),
  })
  .refine((v) => v.lmp !== null || v.scan !== null, 'anc.datingNeeded');
export type CreatePregnancyInput = z.output<typeof createPregnancySchema>;

/** Scan dating entered later (or replaced): the assessment is shown first, then confirmed. */
export const scanDatingSchema = z.object({
  pregnancyId: uuidSchema,
  scanDate: isoDateSchema,
  ga: gaInputSchema,
});

export const confirmDatingSchema = z.object({
  pregnancyId: uuidSchema,
  /** `scan` switches `edd_final` to the scan EDD; `lmp` keeps the LMP EDD. */
  basis: z.enum(DATING_BASES),
  scanDate: isoDateSchema,
  ga: gaInputSchema,
});

const dipstick = z.enum(['nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4']);

/** The ANC visit row (docs/11 §3.3); vitals fill the first columns automatically. */
export const saveAncVisitSchema = z
  .object({
    pregnancyId: uuidSchema,
    /** The OPD visit this ANC visit belongs to; null for a retrospective entry. */
    encounterId: uuidSchema.nullable().default(null),
    visitDate: isoDateSchema,
    weightKg: z.number().min(20).max(250).nullable().default(null),
    bpSys: z.number().int().min(50).max(300).nullable().default(null),
    bpDia: z.number().int().min(20).max(200).nullable().default(null),
    fundalHeightCm: z.number().min(5).max(60).nullable().default(null),
    fhr: z.number().int().min(60).max(220).nullable().default(null),
    presentation: z.enum(PRESENTATIONS).nullable().default(null),
    oedema: z.enum(['none', 'plus1', 'plus2']).nullable().default(null),
    urineProtein: dipstick.nullable().default(null),
    urineSugar: dipstick.nullable().default(null),
    hb: z.number().min(2).max(20).nullable().default(null),
    remarks: optionalText(500),
  })
  .refine((v) => (v.bpSys === null) === (v.bpDia === null), 'validation.vitals.bpOrder')
  .refine(
    (v) => v.bpSys === null || v.bpDia === null || v.bpDia < v.bpSys,
    'validation.vitals.bpOrder',
  );
export type SaveAncVisitInput = z.output<typeof saveAncVisitSchema>;

export const updatePregnancySchema = z.object({
  pregnancyId: uuidSchema,
  bloodGroupRh: bloodGroupRhSchema.nullable(),
  plurality: z.enum(PLURALITIES),
  /** Booking height / weight come from vitals; this is the booking BMI inputs when vitals are missing. */
  manualRisks: z.array(manualRiskSchema).max(12),
  notes: optionalText(500),
});

export const saveHistorySchema = z.object({
  pregnancyId: uuidSchema,
  history: z.array(obHistoryEntrySchema).max(20),
});
export type SaveHistoryInput = z.output<typeof saveHistorySchema>;

/** A hand-edited score (docs/11 §3.1 "editable"); the computed one is restored with `manual: false`. */
export const setGpalSchema = z.discriminatedUnion('manual', [
  z.object({ pregnancyId: uuidSchema, manual: z.literal(false) }),
  z.object({
    pregnancyId: uuidSchema,
    manual: z.literal(true),
    g: z.number().int().min(1).max(25),
    p: z.number().int().min(0).max(24),
    a: z.number().int().min(0).max(24),
    l: z.number().int().min(0).max(24),
  }),
]);

/**
 * Closing a pregnancy. A delivery names how it ended (`obOutcome`) so the next pregnancy's
 * history is complete; `gestationWeeks`, `babiesAlive` and `neonatalDeath` default sensibly.
 */
export const closePregnancySchema = z.object({
  pregnancyId: uuidSchema,
  outcome: z.enum(PREGNANCY_CLOSE_OUTCOMES),
  outcomeDate: isoDateSchema,
  reason: optionalText(300),
  obOutcome: z.enum(['nvd', 'lscs', 'assisted', 'stillbirth']).nullable().default(null),
  babiesAlive: z.number().int().min(0).max(4).nullable().default(null),
  neonatalDeath: z.boolean().default(false),
});

export const markScheduleSchema = z.object({
  pregnancyId: uuidSchema,
  code: z.string().min(1).max(40),
  status: z.enum(ANC_SCHEDULE_STATUSES),
  doneDate: isoDateSchema.nullable().default(null),
});

export type ConfirmDatingInput = z.output<typeof confirmDatingSchema>;
export type UpdatePregnancyInput = z.output<typeof updatePregnancySchema>;
export type SetGpalInput = z.output<typeof setGpalSchema>;
export type ClosePregnancyInput = z.output<typeof closePregnancySchema>;
export type MarkScheduleInput = z.output<typeof markScheduleSchema>;

export const pregnancyIdSchema = z.object({ pregnancyId: uuidSchema });
export const patientPregnanciesSchema = z.object({ patientId: uuidSchema });

/** Short display of a date for the card; kept here so print and web agree. */
export const ancDate = (d: string | null): string => (d ? formatDate(d) : '');
