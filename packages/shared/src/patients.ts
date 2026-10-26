/**
 * Patient registration and search (docs/10 §2–3, docs/04 §3, REG-01/REG-02): enums backing the
 * CHECK constraints, zod schemas shared by the tRPC procedures and the reception forms, and the
 * pure helpers (title-casing, age entry, search-box classification) tested without a database.
 * Nothing here describes a fetus (AGENTS.md rule 7); `sex` is the patient's own.
 */
import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import {
  estimateDob,
  MAX_AGE_YEARS,
  parseAgeInput,
  parseIsoDate,
  toIsoDate,
  compareDates,
  addDays,
} from './dates';
import type { CalendarDate } from './fy';
import { formatSeriesNumber } from './number-series';
import { isoDateSchema, mobileSchema, pincodeSchema, uuidSchema } from './primitives';

export const PATIENT_SEXES = ['F', 'M', 'O'] as const;
export type PatientSex = (typeof PATIENT_SEXES)[number];

export const GUARDIAN_RELATIONS = ['husband', 'father', 'mother', 'other'] as const;
export const MOBILE_OWNER_RELATIONS = [
  'self',
  'husband',
  'wife',
  'father',
  'mother',
  'son',
  'daughter',
  'brother',
  'sister',
  'other',
] as const;
export const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced', 'separated'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/** `patient_identifier.type` (docs/04 §3). Never store a full Aadhaar number. */
export const PATIENT_IDENTIFIER_TYPES = [
  'abha_number',
  'abha_address',
  'aadhaar_masked',
  'pmjay_id',
  'insurance_member_id',
  'employee_id',
  'other',
] as const;
/** Label of the identifier that carries a number from the old register / software (MIG-01). */
export const OLD_REG_NO_LABEL = 'Old reg no';

export const SEARCH_LIMIT = 20;

// ---------------------------------------------------------------- names

/**
 * "  sunita   DEVI " → "Sunita Devi" (docs/10 §3). Each run of letters starts with a capital, so
 * `a.k. d'souza` → `A.K. D'Souza`. Devanagari has no case and passes through.
 */
export function titleCaseName(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{M}])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Single-line free text: trimmed, inner whitespace collapsed. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'validation.invalid')
    .refine(...noForbiddenTerms('always'))
    .transform((s) => s.replace(/\s+/g, ' '));
const optText = (max: number) =>
  text(max)
    .optional()
    .transform((s) => s || null);
const nameText = (max: number) => text(max).transform(titleCaseName);
const optNameText = (max: number) =>
  nameText(max)
    .optional()
    .transform((s) => s || null);

/** `Full name` as stored in `patient.full_name`: first, middle, last. */
export function joinName(p: {
  firstName: string;
  middleName?: string | null;
  lastName?: string | null;
}) {
  return [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- age / DOB

export const dobSchema = isoDateSchema;

/**
 * Resolves the age-or-DOB input to a stored DOB. An entered DOB is exact; an age (`25`, `25y`,
 * `6m`, `15d`) yields an estimated DOB (docs/02 §3). Returns null when the input is unusable
 * (bad format, in the future, older than 120 years).
 */
export function resolveDob(
  input: { dob?: string | null; age?: string | null },
  today: CalendarDate,
): { dob: string; estimated: boolean } | null {
  if (input.dob) {
    let d: CalendarDate;
    try {
      d = parseIsoDate(input.dob);
    } catch {
      return null;
    }
    if (compareDates(d, today) > 0) return null;
    if (compareDates(d, { ...today, year: today.year - MAX_AGE_YEARS - 1 }) < 0) return null;
    return { dob: toIsoDate(d), estimated: false };
  }
  if (input.age) {
    const age = parseAgeInput(input.age);
    if (!age) return null;
    return { dob: toIsoDate(estimateDob(age, today)), estimated: true };
  }
  return null;
}

// ---------------------------------------------------------------- registration input

const baseRegistration = z.object({
  firstName: nameText(60).pipe(z.string().min(1, 'validation.required')),
  middleName: optNameText(60),
  lastName: optNameText(60),
  nameHi: optText(120),
  sex: z.enum(PATIENT_SEXES),
  /** Exactly one of `dob` / `age` (resolved server-side against the IST date). */
  dob: dobSchema.optional(),
  age: text(8).optional(),
  mobile: mobileSchema.optional(),
  /** Required when `mobile` is absent ("No mobile" checkbox, docs/10 §3). */
  noMobileReason: optText(120),
  altMobile: mobileSchema.optional(),
  relationToMobileOwner: z.enum(MOBILE_OWNER_RELATIONS).optional(),
  guardianName: optNameText(120),
  guardianRelation: z.enum(GUARDIAN_RELATIONS).optional(),
  addressLine: optText(200),
  /** Existing locality, or a new name that is learned (docs/05 §2). */
  localityId: uuidSchema.optional(),
  localityName: optText(80),
  district: optText(80),
  state: optText(80),
  pincode: pincodeSchema.optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  maritalStatus: z.enum(MARITAL_STATUSES).optional(),
  occupation: optText(80),
  referredBy: optText(120),
});

function checkRegistration(
  v: z.output<typeof baseRegistration>,
  ctx: z.RefinementCtx,
  requireAge: boolean,
) {
  const hasAge = Boolean(v.dob) || Boolean(v.age);
  if (requireAge && !hasAge) {
    ctx.addIssue({ code: 'custom', path: ['age'], message: 'validation.patient.ageRequired' });
  }
  if (v.dob && v.age) {
    ctx.addIssue({ code: 'custom', path: ['age'], message: 'validation.patient.ageOrDob' });
  }
  if (v.age && !parseAgeInput(v.age)) {
    ctx.addIssue({ code: 'custom', path: ['age'], message: 'validation.patient.ageInvalid' });
  }
  if (!v.mobile && !v.noMobileReason) {
    ctx.addIssue({
      code: 'custom',
      path: ['mobile'],
      message: 'validation.patient.mobileOrReason',
    });
  }
  if (v.mobile && v.altMobile === v.mobile) {
    ctx.addIssue({
      code: 'custom',
      path: ['altMobile'],
      message: 'validation.patient.altMobileSame',
    });
  }
}

export const patientRegistrationSchema = baseRegistration.superRefine((v, ctx) =>
  checkRegistration(v, ctx, true),
);
export type PatientRegistrationInput = z.input<typeof patientRegistrationSchema>;
export type PatientRegistration = z.output<typeof patientRegistrationSchema>;

export const duplicateOverrideSchema = z.object({
  reason: text(200).pipe(z.string().min(3, 'validation.patient.overrideReasonRequired')),
});

export const createPatientSchema = baseRegistration
  .extend({
    /** Reception chose "Create new anyway" in the duplicate modal (reason is logged). */
    duplicateOverride: duplicateOverrideSchema.optional(),
  })
  .superRefine((v, ctx) => checkRegistration(v, ctx, true));
export type CreatePatientInput = z.input<typeof createPatientSchema>;
export type CreatePatient = z.output<typeof createPatientSchema>;

/** Edits keep the same rules; identity edits (name, DOB, sex) are flagged "changed" (docs/10 §3). */
export const updatePatientSchema = baseRegistration
  .extend({ id: uuidSchema })
  .superRefine((v, ctx) => checkRegistration(v, ctx, false));
export type UpdatePatientInput = z.input<typeof updatePatientSchema>;
export type UpdatePatient = z.output<typeof updatePatientSchema>;

export const duplicateCheckSchema = z
  .object({
    firstName: z.string().trim().min(1).max(60),
    middleName: z.string().trim().max(60).optional(),
    lastName: z.string().trim().max(60).optional(),
    mobile: mobileSchema,
    dob: dobSchema.optional(),
    age: text(8).optional(),
  })
  .refine((v) => Boolean(v.dob) !== Boolean(v.age), 'validation.patient.ageOrDob');

// ---------------------------------------------------------------- search box

export type SearchQuery =
  | { kind: 'empty' }
  | { kind: 'mobile'; digits: string; exact: boolean }
  | { kind: 'uhid'; number: number }
  | { kind: 'name'; text: string; extra: string[] };

/**
 * Classifies the single search box (docs/10 §2):
 *  - 10 digits → exact mobile (also `alt_mobile`); 8–9 digits → mobile prefix (a typo-tolerant
 *    extension; the spec leaves them open);
 *  - a UHID with or without prefix, or ≤ 7 digits → UHID number;
 *  - anything else → fuzzy name; words after the first are also tried as guardian / locality.
 * `uhidPrefix` is the facility's configured prefix (default `UH`).
 */
export function classifySearchQuery(raw: string, uhidPrefix = 'UH'): SearchQuery {
  const q = raw.trim().replace(/\s+/g, ' ');
  if (!q) return { kind: 'empty' };
  const compact = q.replace(/[\s-]/g, '');
  const mobile = /^(?:\+?91)?(\d{10})$/.exec(compact);
  if (mobile?.[1] && /^[6-9]/.test(mobile[1]))
    return { kind: 'mobile', digits: mobile[1], exact: true };
  if (/^\d{8,10}$/.test(compact))
    return { kind: 'mobile', digits: compact, exact: compact.length === 10 };
  if (/^\d{1,7}$/.test(compact)) return { kind: 'uhid', number: Number(compact) };
  const prefixed = new RegExp(`^${uhidPrefix}(\\d{1,12})$`, 'i').exec(compact);
  if (prefixed?.[1]) return { kind: 'uhid', number: Number(prefixed[1]) };
  const [first, ...rest] = q.split(' ');
  return { kind: 'name', text: q, extra: rest.length ? [first!, ...rest] : [] };
}

/** `UH-000123` for a UHID number under the given prefix / padding. */
export const formatUhid = (prefix: string, value: number, padding: number) =>
  formatSeriesNumber(prefix, null, value, padding);

/**
 * Age tolerance of the duplicate rule: two DOBs are "within ±N years" when they differ by at
 * most N × 366 days (estimated DOBs can be a year out, so a day-level rule is deliberately loose).
 */
export function dobWithinYears(a: string, b: string, years: number): boolean {
  const da = parseIsoDate(a);
  const db = parseIsoDate(b);
  const limit = Math.round(years * 366);
  return compareDates(addDays(da, limit), db) >= 0 && compareDates(addDays(db, limit), da) >= 0;
}
