import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { addDays, istToday, parseIsoDate, toIsoDate, compareDates } from './dates';
import { DRUG_FORMS, type DrugForm } from './masters';
import { idempotencyKeySchema, isoDateSchema, uuidSchema } from './primitives';

/**
 * Prescription transcription (OPD-02, docs/11 §2): the enums behind `prescription`,
 * `prescription_item` and `clinical_order` (docs/04 §5), quantity arithmetic, the non-blocking
 * dose sanity warnings and the zod inputs of the `rx.*` procedures. The software records what the
 * doctor wrote on paper; it never changes a dose (docs/11 §4.4).
 */

// ---------------------------------------------------------------- enums

export const RX_SOURCES = ['transcribed_from_paper', 'entered_by_doctor', 'discharge'] as const;
export type RxSource = (typeof RX_SOURCES)[number];

/** `superseded`: an earlier version replaced by a correction (kept on record, AGENTS.md rule 4). */
export const RX_STATUSES = ['draft', 'final', 'verified', 'cancelled', 'superseded'] as const;
export type RxStatus = (typeof RX_STATUSES)[number];

/** docs/04 §5, plus `ALT` (alternate days, docs/11 §2.3). */
export const FREQUENCY_CODES = [
  'OD',
  'BD',
  'TDS',
  'QID',
  'HS',
  'SOS',
  'STAT',
  'WEEKLY',
  'ALT',
] as const;
export type FrequencyCode = (typeof FREQUENCY_CODES)[number];

export const RX_TIMINGS = ['af', 'bf', 'with_food', 'empty_stomach', 'any'] as const;
export type RxTiming = (typeof RX_TIMINGS)[number];

export const RX_ROUTES = [
  'oral',
  'im',
  'iv',
  'sc',
  'sl',
  'pv',
  'pr',
  'topical',
  'inhalation',
  'nasal',
  'eye',
  'ear',
] as const;
export type RxRoute = (typeof RX_ROUTES)[number];

export const DURATION_UNITS = ['d', 'w', 'm'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** Days per unit for quantities (a month is counted as 30 days, docs/11 §2.3 `x1m` → 60 for BD). */
export const DAYS_PER_UNIT: Record<DurationUnit, number> = { d: 1, w: 7, m: 30 };

export const ORDER_KINDS = [
  'lab',
  'usg',
  'procedure',
  'admission',
  'referral',
  'cardiology_test',
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_STATUSES = [
  'ordered',
  'billed',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_PRIORITIES = ['routine', 'urgent'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

/** Service categories an OPD order may be placed for, and the order kind each one makes. */
export const ORDERABLE_CATEGORIES = {
  lab: 'lab',
  usg: 'usg',
  procedure: 'procedure',
  cardiology: 'cardiology_test',
} as const satisfies Record<string, OrderKind>;
export type OrderableCategory = keyof typeof ORDERABLE_CATEGORIES;
export const isOrderableCategory = (c: string): c is OrderableCategory =>
  Object.hasOwn(ORDERABLE_CATEGORIES, c);

export const NOTE_STATUSES = ['draft', 'final', 'superseded'] as const;
export const RX_DRAFT_STATUSES = ['open', 'used', 'discarded'] as const;

/** `Rx verification` (Q15): `off`, `sample` (default: a random share + all with warnings), `all`. */
export type RxVerifyMode = 'off' | 'sample' | 'all';

/** Forms counted in units (pattern sum × days, docs/11 §2.3). Liquids, creams, injections: blank. */
export const SOLID_FORMS: readonly DrugForm[] = ['tab', 'cap', 'sachet', 'pessary'];
export const isSolidForm = (f: DrugForm | null | undefined) => !!f && SOLID_FORMS.includes(f);

/** Patterns of the codes that have one (docs/11 §2.3: `bd` = 1-0-1). */
export const CODE_PATTERN: Partial<Record<FrequencyCode, string>> = {
  OD: '1-0-0',
  BD: '1-0-1',
  TDS: '1-1-1',
  QID: '1-1-1-1',
  HS: '0-0-1',
};

// ---------------------------------------------------------------- patterns and quantity

const SLOT = /^(?:\d{1,2}(?:\.\d{1,2})?|½|¼|¾|\d\/\d)$/;
export const PATTERN_RE =
  /^(?:\d{1,2}(?:\.\d{1,2})?|½|¼|¾|\d\/\d)(?:-(?:\d{1,2}(?:\.\d{1,2})?|½|¼|¾|\d\/\d)){2,3}$/;

/** Value of one slot of a pattern (`½`, `1/2`, `0.5`, `2`); NaN when it is not one. */
export function slotValue(s: string): number {
  if (!SLOT.test(s)) return Number.NaN;
  if (s === '½') return 0.5;
  if (s === '¼') return 0.25;
  if (s === '¾') return 0.75;
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number) as [number, number];
    return b === 0 ? Number.NaN : a / b;
  }
  return Number(s);
}

/** Doses per day of a `1-0-1` pattern (sum of the slots); null when it is not a pattern. */
export function patternSum(pattern: string): number | null {
  if (!PATTERN_RE.test(pattern)) return null;
  const sum = pattern.split('-').reduce((a, s) => a + slotValue(s), 0);
  return Number.isFinite(sum) ? sum : null;
}

/** Days covered by a duration; null when there is none. */
export function durationDays(value: number | null, unit: DurationUnit | null): number | null {
  if (value === null || unit === null || !(value > 0)) return null;
  return value * DAYS_PER_UNIT[unit];
}

export interface QuantityInput {
  form: DrugForm | null;
  pattern: string | null;
  frequencyCode: FrequencyCode | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  /** Units per administration when the line has a code but no pattern (`½ tab bd`). */
  unitsPerDose?: number | null;
}

/**
 * Units to dispense for a solid form (docs/11 §2.3): doses per day × days, rounded up to a whole
 * unit. `ALT` doses every other day, `WEEKLY` once a week, `STAT` once. Null for liquids, creams
 * and injections, for `SOS`, and when the duration is missing: the assistant types those.
 */
export function rxQuantity(i: QuantityInput): number | null {
  if (!isSolidForm(i.form)) return null;
  const perDose = i.unitsPerDose && i.unitsPerDose > 0 ? i.unitsPerDose : 1;
  const fromPattern = i.pattern ? patternSum(i.pattern) : null;
  if (i.frequencyCode === 'STAT') return Math.ceil(fromPattern ?? perDose);
  if (i.frequencyCode === 'SOS') return null;
  const days = durationDays(i.durationValue, i.durationUnit);
  if (days === null) return null;
  // A pattern filled in from a code (`½ tab bd` → 1-0-1) counts the written units per dose.
  const fromCode = !!i.frequencyCode && i.pattern === CODE_PATTERN[i.frequencyCode];
  let perDay: number | null = fromPattern === null ? null : fromPattern * (fromCode ? perDose : 1);
  if (perDay === null && i.frequencyCode) {
    const p = CODE_PATTERN[i.frequencyCode];
    perDay = p
      ? patternSum(p)! * perDose
      : i.frequencyCode === 'WEEKLY' || i.frequencyCode === 'ALT'
        ? perDose
        : null;
  }
  if (perDay === null || perDay <= 0) return null;
  const dosingDays =
    i.frequencyCode === 'ALT'
      ? Math.ceil(days / 2)
      : i.frequencyCode === 'WEEKLY'
        ? Math.ceil(days / 7)
        : days;
  return Math.ceil(perDay * dosingDays - 1e-9);
}

// ---------------------------------------------------------------- warnings (non-blocking)

export const RX_WARNING_CODES = [
  'duplicate_drug',
  'duplicate_generic',
  'many_units_per_dose',
  'many_doses_per_day',
  'long_duration',
  'large_quantity',
  'no_frequency',
  'no_duration',
  'free_text_drug',
] as const;
export type RxWarningCode = (typeof RX_WARNING_CODES)[number];

export interface RxWarning {
  code: RxWarningCode;
  /** 0-based row of the medicines grid. */
  row: number;
}

/** Sanity limits for the warnings; deliberately loose: they ask "is this what the paper says?". */
export const RX_SANITY = {
  maxUnitsPerDose: 4,
  maxDosesPerDay: 6,
  maxDays: 180,
  maxQuantity: 300,
} as const;

export interface WarnableItem {
  drugId: string | null;
  drugName: string;
  genericName?: string | null;
  form: DrugForm | null;
  pattern: string | null;
  frequencyCode: FrequencyCode | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  quantity: number | null;
}

/**
 * Inline warnings of the medicines grid (docs/11 §2.3): duplicates in the same Rx, doses that look
 * like a typing slip, missing frequency or duration, and drugs not in the master. Allergy,
 * pregnancy-caution and paediatric dose rules join when their masters exist (OPD-05/06); none is
 * invented here. Warnings never block saving.
 */
export function rxWarnings(items: readonly WarnableItem[]): RxWarning[] {
  const out: RxWarning[] = [];
  const seenDrug = new Map<string, number>();
  const seenGeneric = new Map<string, number>();
  items.forEach((it, row) => {
    const add = (code: RxWarningCode) => out.push({ code, row });
    if (it.drugId) {
      if (seenDrug.has(it.drugId)) add('duplicate_drug');
      else seenDrug.set(it.drugId, row);
    } else {
      add('free_text_drug');
    }
    const generic = it.genericName?.trim().toLowerCase();
    if (generic && !(it.drugId && seenDrug.get(it.drugId) !== row)) {
      if (seenGeneric.has(generic)) add('duplicate_generic');
      else seenGeneric.set(generic, row);
    }
    const slots =
      it.pattern && PATTERN_RE.test(it.pattern) ? it.pattern.split('-').map(slotValue) : [];
    if (slots.some((s) => s > RX_SANITY.maxUnitsPerDose)) add('many_units_per_dose');
    const perDay = it.pattern ? patternSum(it.pattern) : null;
    if (perDay !== null && perDay > RX_SANITY.maxDosesPerDay) add('many_doses_per_day');
    if (!it.pattern && !it.frequencyCode) add('no_frequency');
    const days = durationDays(it.durationValue, it.durationUnit);
    if (days !== null && days > RX_SANITY.maxDays) add('long_duration');
    const regular = it.frequencyCode !== 'SOS' && it.frequencyCode !== 'STAT';
    if (days === null && regular && isSolidForm(it.form) && (it.pattern || it.frequencyCode)) {
      add('no_duration');
    }
    if (it.quantity !== null && it.quantity > RX_SANITY.maxQuantity) add('large_quantity');
  });
  return out;
}

// ---------------------------------------------------------------- verification sampling (Q15)

/**
 * Whether a saved transcription goes to the doctor's verification queue (docs/11 §2.7): never in
 * `off`, always in `all`; in `sample` every Rx with a warning plus a random `percent` share.
 * `random` is in [0, 1) (crypto-backed on the server).
 */
export function needsVerification(
  mode: RxVerifyMode,
  percent: number,
  hasWarnings: boolean,
  random: number,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return hasWarnings || random < percent / 100;
}

// ---------------------------------------------------------------- follow-up

/** Quick buttons of the Follow-up tab (docs/11 §2.6). */
export const FOLLOW_UP_QUICK_DAYS = [3, 7, 15, 30] as const;
/** The furthest a follow-up may be booked. */
export const FOLLOW_UP_MAX_DAYS = 365;

/** `YYYY-MM-DD` N days after the IST day of `now`. */
export const followUpDateAfter = (now: Date, days: number): string =>
  toIsoDate(addDays(istToday(now), days));

/** A follow-up must be after today and within a year (a past date cannot be picked, docs/05 §1.10). */
export function isValidFollowUpDate(date: string, now: Date): boolean {
  const d = parseIsoDate(date);
  const today = istToday(now);
  return compareDates(d, today) > 0 && compareDates(d, addDays(today, FOLLOW_UP_MAX_DAYS)) <= 0;
}

// ---------------------------------------------------------------- zod inputs

/** Free text on clinical screens: trimmed, guarded (D-10, `always` tier). */
const clinicalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'validation.invalid')
    .refine(...noForbiddenTerms('always'));
const optClinicalText = (max: number) =>
  clinicalText(max)
    .nullish()
    .transform((s) => s || null);

export const RX_MAX_ITEMS = 30;
export const RX_MAX_ORDERS = 40;

export const rxItemSchema = z
  .object({
    drugId: uuidSchema.nullable(),
    /** Display name: the master's name, or the free text typed for an unknown drug. */
    drugName: clinicalText(120).pipe(z.string().min(1, 'validation.required')),
    form: z.enum(DRUG_FORMS).nullable(),
    doseText: optClinicalText(40),
    frequencyCode: z.enum(FREQUENCY_CODES).nullable(),
    pattern: z.string().regex(PATTERN_RE, 'validation.rx.pattern').nullable(),
    timing: z.enum(RX_TIMINGS).nullable(),
    route: z.enum(RX_ROUTES).nullable(),
    durationValue: z.number().int().min(1).max(365).nullable(),
    durationUnit: z.enum(DURATION_UNITS).nullable(),
    quantity: z.number().min(0).max(99_999).multipleOf(0.5).nullable(),
    instructionsEn: optClinicalText(300),
    instructionsHi: optClinicalText(300),
    /** The shorthand line the row came from, kept so a failed parse loses nothing. */
    sourceLine: optClinicalText(200),
  })
  .refine((i) => (i.durationValue === null) === (i.durationUnit === null), {
    message: 'validation.rx.duration',
    path: ['durationValue'],
  });
export type RxItemInput = z.input<typeof rxItemSchema>;
export type RxItem = z.output<typeof rxItemSchema>;

export const rxOrderSchema = z.object({
  serviceId: uuidSchema,
  priority: z.enum(ORDER_PRIORITIES).default('routine'),
  notes: optClinicalText(200),
});
export type RxOrderInput = z.input<typeof rxOrderSchema>;

export const rxAdmissionSchema = z.object({
  advised: z.boolean(),
  expectedDate: isoDateSchema.nullish().transform((v) => v ?? null),
  /** Package suggestion / reason, free text until packages exist (BIL-07). */
  note: optClinicalText(200),
});

export const rxNoteSchema = z.object({
  complaints: z
    .array(clinicalText(80).pipe(z.string().min(1)))
    .max(20)
    .default([]),
  complaintsText: optClinicalText(500),
  diagnosis: optClinicalText(300),
  advice: z
    .array(clinicalText(120).pipe(z.string().min(1)))
    .max(20)
    .default([]),
  adviceText: optClinicalText(500),
});
export type RxNoteInput = z.input<typeof rxNoteSchema>;

export const saveRxSchema = z.object({
  encounterId: uuidSchema,
  /** Double-click / retry safety: the same key replays the first result. */
  idempotencyKey: idempotencyKeySchema,
  items: z.array(rxItemSchema).max(RX_MAX_ITEMS),
  orders: z
    .array(rxOrderSchema)
    .max(RX_MAX_ORDERS)
    .refine(
      (o) => new Set(o.map((x) => x.serviceId)).size === o.length,
      'validation.rx.duplicateOrder',
    ),
  admission: rxAdmissionSchema.default({ advised: false, expectedDate: null, note: null }),
  note: rxNoteSchema.default({
    complaints: [],
    complaintsText: null,
    diagnosis: null,
    advice: [],
    adviceText: null,
  }),
  followUpDate: isoDateSchema.nullish().transform((v) => v ?? null),
  /** The paper photo (`document.kind = rx_scan`) this transcription is read from. */
  scanDocumentId: uuidSchema.nullish().transform((v) => v ?? null),
});
export type SaveRxInput = z.input<typeof saveRxSchema>;

/**
 * A draft as autosaved (docs/01 §3): the screen's state, loosely typed so that a half-typed row is
 * kept. It is validated properly only when the Rx is saved. Text is still guarded (D-10).
 */
const draftText = (max: number) => clinicalText(max).nullish();
export const rxDraftPayloadSchema = z.object({
  items: z
    .array(
      z.object({
        drugId: uuidSchema.nullish(),
        drugName: draftText(120),
        genericName: draftText(120),
        form: z.enum(DRUG_FORMS).nullish(),
        doseText: draftText(40),
        frequencyCode: z.enum(FREQUENCY_CODES).nullish(),
        pattern: draftText(20),
        timing: z.enum(RX_TIMINGS).nullish(),
        route: z.enum(RX_ROUTES).nullish(),
        durationValue: z.number().int().min(0).max(999).nullish(),
        durationUnit: z.enum(DURATION_UNITS).nullish(),
        quantity: z.number().min(0).max(99_999).nullish(),
        instructionsEn: draftText(300),
        instructionsHi: draftText(300),
        sourceLine: draftText(200),
      }),
    )
    .max(RX_MAX_ITEMS),
  /** The shorthand line being typed. */
  line: draftText(200),
  orders: z.array(uuidSchema).max(RX_MAX_ORDERS),
  admission: z.object({
    advised: z.boolean(),
    expectedDate: draftText(10),
    note: draftText(200),
  }),
  note: z.object({
    complaints: z.array(clinicalText(80)).max(20),
    complaintsText: draftText(500),
    diagnosis: draftText(300),
    advice: z.array(clinicalText(120)).max(20),
    adviceText: draftText(500),
  }),
  followUpDate: draftText(10),
  scanDocumentId: uuidSchema.nullish(),
});
export type RxDraftPayload = z.infer<typeof rxDraftPayloadSchema>;

export const saveRxDraftSchema = z.object({
  encounterId: uuidSchema,
  payload: rxDraftPayloadSchema,
});

export const encounterIdSchema = z.object({ encounterId: uuidSchema });

export const RX_SCAN_MIME = 'image/jpeg';
/** docs/01 §2: max upload 10 MB (the client compresses to ≤ 1600 px, JPEG 0.8, first). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Longest side and JPEG quality of the client-side compression (docs/01 §2). */
export const RX_SCAN_MAX_SIDE = 1600;
export const RX_SCAN_JPEG_QUALITY = 0.8;

/** Size of an image scaled to fit `max` on its longest side (never enlarged). */
export function fitWithin(width: number, height: number, max = RX_SCAN_MAX_SIDE) {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export const attachRxScanSchema = z.object({
  encounterId: uuidSchema,
  /** Base64 of the compressed JPEG. */
  dataBase64: z
    .string()
    .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4, 'validation.rx.scanTooLarge')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'validation.rx.scanInvalid'),
  /** Replace this earlier scan (it is cancelled with a reason, never deleted). */
  replacesDocumentId: uuidSchema.nullish().transform((v) => v ?? null),
});

export const verifyRxSchema = z.object({ prescriptionId: uuidSchema });

export const drugSearchSchema = z.object({
  encounterId: uuidSchema,
  q: z.string().trim().min(1).max(60),
  form: z.enum(DRUG_FORMS).nullish(),
});

export const orderSearchSchema = z.object({
  q: z.string().trim().min(1).max(60),
});
