import { z } from 'zod';
import { type Age } from './dates';
import { uuidSchema } from './primitives';

/**
 * Vitals desk rules (OPD-01, docs/11 §1): which fields a patient gets, which values are impossible
 * (blocked), which are out of range (flagged amber / red) and the unit conversions. Pure and
 * shared, so the form and the server apply exactly the same rules. The thresholds are clinical
 * seeds the owner reviews before go-live, so they live in the `vitals.thresholds` setting.
 * The software flags and reminds; it never decides treatment.
 */

export const VITALS_GROUPS = ['adult', 'pregnant', 'child'] as const;
export type VitalsGroup = (typeof VITALS_GROUPS)[number];

/** Stored as words (CHECK-safe); shown as none / + / ++. */
export const OEDEMA_GRADES = ['none', 'plus1', 'plus2'] as const;
export type OedemaGrade = (typeof OEDEMA_GRADES)[number];

/** Urine dipstick reading (albumin / sugar). */
export const DIPSTICK_GRADES = ['nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4'] as const;

/** What the desk sees and the sheet prints for a stored grade. */
export const GRADE_SYMBOL: Record<OedemaGrade | DipstickGrade, string> = {
  none: '—',
  nil: 'Nil',
  trace: 'Trace',
  plus1: '+',
  plus2: '++',
  plus3: '+++',
  plus4: '++++',
};
export type DipstickGrade = (typeof DIPSTICK_GRADES)[number];

export const VITALS_STATUSES = ['active', 'superseded'] as const;

/** `amber` / `red` are reading bands; `alert` is a patient alert for the doctor (not a band). */
export const VITALS_FLAG_LEVELS = ['amber', 'red', 'alert'] as const;
export type VitalsFlagLevel = (typeof VITALS_FLAG_LEVELS)[number];

export const VITALS_FLAG_CODES = [
  'bp_high',
  'spo2_low',
  'temp_high',
  'pulse_low',
  'pulse_high',
  'rbs_high',
  'raised_bp_pregnancy',
] as const;
export type VitalsFlagCode = (typeof VITALS_FLAG_CODES)[number];

/** Field a flag belongs to (the form colours that input; the OPD sheet marks that box). */
export type VitalsFlagField = 'bp' | 'pulse' | 'temp' | 'spo2' | 'rbs';

export interface VitalsFlag {
  code: VitalsFlagCode;
  field: VitalsFlagField;
  level: VitalsFlagLevel;
}

// ---------------------------------------------------------------- thresholds (setting)

const bp = z.object({
  sys: z.number().int().min(50).max(300),
  dia: z.number().int().min(20).max(200),
});

export const vitalsThresholdsSchema = z.object({
  /** BP is flagged when systolic OR diastolic reaches the limit. */
  bpAmber: bp,
  bpRed: bp,
  /** SpO2 below the limit. */
  spo2Amber: z.number().int().min(50).max(100),
  spo2Red: z.number().int().min(50).max(100),
  /** Temperature at or above, in °C. */
  tempAmberC: z.number().min(34).max(43),
  /** Pulse below `pulseLow` or above `pulseHigh`. */
  pulseLow: z.number().int().min(20).max(120),
  pulseHigh: z.number().int().min(60).max(250),
  /** Random blood sugar above, mg/dL. */
  rbsHigh: z.number().int().min(80).max(1000),
});
export type VitalsThresholds = z.output<typeof vitalsThresholdsSchema>;

/** docs/11 §1 defaults. */
export const DEFAULT_VITALS_THRESHOLDS: VitalsThresholds = {
  bpAmber: { sys: 140, dia: 90 },
  bpRed: { sys: 160, dia: 110 },
  spo2Amber: 94,
  spo2Red: 90,
  tempAmberC: 38.0,
  pulseLow: 50,
  pulseHigh: 120,
  rbsHigh: 200,
};

/** Height is asked for again after this many days without a measurement (docs/11: once a year). */
export const DEFAULT_HEIGHT_PROMPT_DAYS = 365;

// ---------------------------------------------------------------- groups

/** Fields entered on the form, per group, in paper order (the tab order). */
export const VITALS_FIELDS = [
  'bpSys',
  'bpDia',
  'pulse',
  'tempF',
  'spo2',
  'rr',
  'weightKg',
  'heightCm',
  'headCircCm',
  'muacCm',
  'rbsMgdl',
  'fundalHeightCm',
  'fhr',
  'oedema',
  'urineAlbumin',
  'urineSugar',
] as const;
export type VitalsField = (typeof VITALS_FIELDS)[number];

const ADULT_FIELDS: readonly VitalsField[] = [
  'bpSys',
  'bpDia',
  'pulse',
  'tempF',
  'spo2',
  'weightKg',
  'heightCm',
  'rbsMgdl',
];
const FIELDS_BY_GROUP: Record<VitalsGroup, readonly VitalsField[]> = {
  adult: ADULT_FIELDS,
  pregnant: [...ADULT_FIELDS, 'fundalHeightCm', 'fhr', 'oedema', 'urineAlbumin', 'urineSugar'],
  child: ['weightKg', 'heightCm', 'headCircCm', 'tempF', 'spo2', 'rr', 'muacCm'],
};

/** The child group is under 18 years (docs/11 §1); head circumference is asked under 2 years only. */
export const CHILD_AGE_LIMIT_YEARS = 18;

export interface VitalsPatient {
  /** From `ageFromDob`. */
  age: Age;
  sex: string;
}

const ageYears = (age: Age) => (age.unit === 'years' ? age.value : 0);

/**
 * Groups open to a patient. Adults and children follow the age. The pregnant form (adult fields
 * plus pregnancy fields) is open to any non-male patient of 10 years or more, minors included,
 * because a pregnant girl still needs her BP taken and watched.
 */
export function allowedVitalsGroups(p: VitalsPatient): VitalsGroup[] {
  const years = ageYears(p.age);
  const groups: VitalsGroup[] = [years < CHILD_AGE_LIMIT_YEARS ? 'child' : 'adult'];
  if (p.sex !== 'M' && years >= 10) groups.push('pregnant');
  return groups;
}

/** Group the form opens with; `pregnant` is only chosen when the desk says so (or history does). */
export function defaultVitalsGroup(p: VitalsPatient, pregnant: boolean): VitalsGroup {
  const allowed = allowedVitalsGroups(p);
  return pregnant && allowed.includes('pregnant') ? 'pregnant' : allowed[0]!;
}

/** Fields of a group for this patient (head circumference only under 2 years). */
export function vitalsFieldsFor(group: VitalsGroup, p: VitalsPatient): VitalsField[] {
  return FIELDS_BY_GROUP[group].filter((f) => f !== 'headCircCm' || p.age.unit !== 'years');
}

// ---------------------------------------------------------------- conversions

const round = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
};

/**
 * Thermometers here read °F; the record keeps °C (docs/11 §1). Two decimals, so that converting
 * back to °F at one decimal returns what was typed (101 °F → 38.33 °C → 101 °F; one decimal of
 * °C would print it as 100.9).
 */
export const fahrenheitToCelsius = (f: number): number => round(((f - 32) * 5) / 9, 2);
export const celsiusToFahrenheit = (c: number): number => round((c * 9) / 5 + 32, 1);

/** kg / m², one decimal. */
export const bmi = (weightKg: number, heightCm: number): number =>
  round(weightKg / (heightCm / 100) ** 2, 1);

// ---------------------------------------------------------------- input

const num = z.number().finite();
const int = z.number().int();

/** What the form sends: only the fields that were filled (blank = not recorded). */
export const vitalsValuesSchema = z
  .object({
    bpSys: int.optional(),
    bpDia: int.optional(),
    pulse: int.optional(),
    /** Entered in °F, stored in °C. */
    tempF: num.optional(),
    spo2: int.optional(),
    rr: int.optional(),
    weightKg: num.optional(),
    heightCm: num.optional(),
    headCircCm: num.optional(),
    muacCm: num.optional(),
    rbsMgdl: int.optional(),
    fundalHeightCm: num.optional(),
    fhr: int.optional(),
    oedema: z.enum(OEDEMA_GRADES).optional(),
    urineAlbumin: z.enum(DIPSTICK_GRADES).optional(),
    urineSugar: z.enum(DIPSTICK_GRADES).optional(),
  })
  .strict();
export type VitalsValues = z.output<typeof vitalsValuesSchema>;

/** Impossible values are blocked (docs/11 §1 "Implausible values blocked"). Inclusive limits. */
const LIMITS = {
  bpSys: [50, 300],
  bpDia: [20, 200],
  pulse: [20, 250],
  tempF: [86, 113],
  spo2: [50, 100],
  rr: [4, 120],
  rbsMgdl: [10, 1000],
  fundalHeightCm: [5, 50],
  fhr: [60, 220],
  headCircCm: [15, 65],
  muacCm: [5, 40],
} as const satisfies Partial<Record<VitalsField, readonly [number, number]>>;

/** Weight and height depend on the group: a 650 kg adult or a 40 cm adult is a typing slip. */
const BODY_LIMITS: Record<'weightKg' | 'heightCm', Record<'adult' | 'child', [number, number]>> = {
  weightKg: { adult: [20, 300], child: [0.3, 200] },
  heightCm: { adult: [100, 250], child: [20, 220] },
};

export const vitalsLimit = (
  field: VitalsField,
  group: VitalsGroup,
): readonly [number, number] | null => {
  if (field === 'weightKg' || field === 'heightCm') {
    return BODY_LIMITS[field][group === 'child' ? 'child' : 'adult'];
  }
  return (LIMITS as Partial<Record<VitalsField, readonly [number, number]>>)[field] ?? null;
};

export interface VitalsIssue {
  field: VitalsField;
  /** i18n key (validation.vitals.*). */
  key:
    | 'validation.vitals.implausible'
    | 'validation.vitals.bpBoth'
    | 'validation.vitals.bpOrder'
    | 'validation.vitals.notForGroup';
}

/** Checks entered values for a group; returns every problem (empty = fine). */
export function validateVitals(
  group: VitalsGroup,
  values: VitalsValues,
  patient?: VitalsPatient,
): VitalsIssue[] {
  const issues: VitalsIssue[] = [];
  const allowed: readonly VitalsField[] = patient
    ? vitalsFieldsFor(group, patient)
    : FIELDS_BY_GROUP[group];
  for (const field of VITALS_FIELDS) {
    const v = values[field];
    if (v === undefined) continue;
    if (!allowed.includes(field)) {
      issues.push({ field, key: 'validation.vitals.notForGroup' });
      continue;
    }
    const limit = vitalsLimit(field, group);
    if (limit && typeof v === 'number' && (v < limit[0] || v > limit[1])) {
      issues.push({ field, key: 'validation.vitals.implausible' });
    }
  }
  const { bpSys, bpDia } = values;
  if ((bpSys === undefined) !== (bpDia === undefined)) {
    issues.push({
      field: bpSys === undefined ? 'bpSys' : 'bpDia',
      key: 'validation.vitals.bpBoth',
    });
  } else if (bpSys !== undefined && bpDia !== undefined && bpDia >= bpSys) {
    issues.push({ field: 'bpDia', key: 'validation.vitals.bpOrder' });
  }
  return issues;
}

/** True when at least one reading was entered. */
export const hasAnyVitals = (values: VitalsValues): boolean =>
  VITALS_FIELDS.some((f) => values[f] !== undefined);

export const recordVitalsSchema = z
  .object({
    tokenId: uuidSchema,
    group: z.enum(VITALS_GROUPS),
    values: vitalsValuesSchema,
  })
  .superRefine((v, ctx) => {
    if (!hasAnyVitals(v.values)) {
      ctx.addIssue({ code: 'custom', path: ['values'], message: 'validation.vitals.atLeastOne' });
    }
    for (const i of validateVitals(v.group, v.values)) {
      ctx.addIssue({ code: 'custom', path: ['values', i.field], message: i.key });
    }
  });
export type RecordVitalsInput = z.output<typeof recordVitalsSchema>;

// ---------------------------------------------------------------- stored form + flags

/** The record as stored: °C, rounded to the column precision, BMI computed. */
export interface StoredVitals {
  bpSys: number | null;
  bpDia: number | null;
  pulse: number | null;
  tempC: number | null;
  spo2: number | null;
  rr: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bmi: number | null;
  headCircCm: number | null;
  muacCm: number | null;
  rbsMgdl: number | null;
  fundalHeightCm: number | null;
  fhr: number | null;
  oedema: OedemaGrade | null;
  urineAlbumin: DipstickGrade | null;
  urineSugar: DipstickGrade | null;
}

/** Entered values → what is stored (flags are judged on this, so they match the record). */
export function normaliseVitals(group: VitalsGroup, v: VitalsValues): StoredVitals {
  const n = (x: number | undefined, d: number) => (x === undefined ? null : round(x, d));
  const weightKg = n(v.weightKg, 2);
  const heightCm = n(v.heightCm, 1);
  return {
    bpSys: v.bpSys ?? null,
    bpDia: v.bpDia ?? null,
    pulse: v.pulse ?? null,
    tempC: v.tempF === undefined ? null : fahrenheitToCelsius(v.tempF),
    spo2: v.spo2 ?? null,
    rr: v.rr ?? null,
    weightKg,
    heightCm,
    bmi:
      group !== 'child' && weightKg !== null && heightCm !== null ? bmi(weightKg, heightCm) : null,
    headCircCm: n(v.headCircCm, 1),
    muacCm: n(v.muacCm, 1),
    rbsMgdl: v.rbsMgdl ?? null,
    fundalHeightCm: n(v.fundalHeightCm, 1),
    fhr: v.fhr ?? null,
    oedema: v.oedema ?? null,
    urineAlbumin: v.urineAlbumin ?? null,
    urineSugar: v.urineSugar ?? null,
  };
}

/**
 * Out-of-range flags (docs/11 §1). Only readings the group collects are judged: children get
 * temperature and SpO2 flags, not BP / pulse / sugar (paediatric bands are not in the defaults,
 * so none are invented). A pregnant patient with BP at the amber band also gets the
 * "Raised BP in pregnancy" alert for the doctor.
 */
export function evaluateVitals(
  group: VitalsGroup,
  v: Pick<StoredVitals, 'bpSys' | 'bpDia' | 'pulse' | 'tempC' | 'spo2' | 'rbsMgdl'>,
  t: VitalsThresholds = DEFAULT_VITALS_THRESHOLDS,
): VitalsFlag[] {
  const flags: VitalsFlag[] = [];
  if (group !== 'child') {
    if (v.bpSys !== null && v.bpDia !== null) {
      const reaches = (lim: { sys: number; dia: number }) =>
        v.bpSys! >= lim.sys || v.bpDia! >= lim.dia;
      if (reaches(t.bpRed)) flags.push({ code: 'bp_high', field: 'bp', level: 'red' });
      else if (reaches(t.bpAmber)) flags.push({ code: 'bp_high', field: 'bp', level: 'amber' });
      if (group === 'pregnant' && reaches(t.bpAmber)) {
        flags.push({ code: 'raised_bp_pregnancy', field: 'bp', level: 'alert' });
      }
    }
    if (v.pulse !== null) {
      if (v.pulse < t.pulseLow) flags.push({ code: 'pulse_low', field: 'pulse', level: 'amber' });
      else if (v.pulse > t.pulseHigh) {
        flags.push({ code: 'pulse_high', field: 'pulse', level: 'amber' });
      }
    }
    if (v.rbsMgdl !== null && v.rbsMgdl > t.rbsHigh) {
      flags.push({ code: 'rbs_high', field: 'rbs', level: 'amber' });
    }
  }
  if (v.spo2 !== null) {
    if (v.spo2 < t.spo2Red) flags.push({ code: 'spo2_low', field: 'spo2', level: 'red' });
    else if (v.spo2 < t.spo2Amber) flags.push({ code: 'spo2_low', field: 'spo2', level: 'amber' });
  }
  if (v.tempC !== null && v.tempC >= t.tempAmberC) {
    flags.push({ code: 'temp_high', field: 'temp', level: 'amber' });
  }
  return flags;
}

/** Strongest band per field, for colouring inputs and sheet boxes. Alerts are not a band. */
export function flagLevelByField(
  flags: readonly VitalsFlag[],
): Partial<Record<VitalsFlagField, 'amber' | 'red'>> {
  const out: Partial<Record<VitalsFlagField, 'amber' | 'red'>> = {};
  for (const f of flags) {
    if (f.level === 'alert') continue;
    if (out[f.field] !== 'red') out[f.field] = f.level;
  }
  return out;
}

/** Defensive read of the `vitals.flags` jsonb column. */
export function parseVitalsFlags(raw: unknown): VitalsFlag[] {
  const parsed = z
    .array(
      z.object({
        code: z.enum(VITALS_FLAG_CODES),
        field: z.enum(['bp', 'pulse', 'temp', 'spo2', 'rbs']),
        level: z.enum(VITALS_FLAG_LEVELS),
      }),
    )
    .safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** Whether a height reading is old enough to ask for again. `lastHeightOn`, `today`: `YYYY-MM-DD`. */
export function heightDue(lastHeightOn: string | null, today: string, promptDays: number): boolean {
  if (!lastHeightOn) return true;
  const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
  return (ms(today) - ms(lastHeightOn)) / 86_400_000 >= promptDays;
}
