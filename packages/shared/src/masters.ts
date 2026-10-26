/**
 * Master data (docs/04 §2, FND-07): enums backing the CHECK constraints and the zod schemas used
 * by both the tRPC procedures and the admin forms (docs/02 §8). Money is integer paise; GST is
 * basis points (AGENTS.md rule 1). Master rows are never deleted: `cancel` records a reason and
 * `restore` reverses it (AGENTS.md rule 4).
 */
import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { RECORD_STATUSES } from './enums';
import {
  gstRateBpSchema,
  hsnSacSchema,
  isoDateSchema,
  nonNegativePaiseSchema,
  uuidSchema,
} from './primitives';

export const MASTER_STATUSES = RECORD_STATUSES;

export const PAYER_TYPES = [
  'self',
  'pmjay',
  'state_scheme',
  'tpa',
  'insurer',
  'corporate',
  'cghs',
  'echs',
  'other',
] as const;
export type PayerType = (typeof PAYER_TYPES)[number];

export const SERVICE_CATEGORIES = [
  'consultation',
  'procedure',
  'usg',
  'lab',
  'bed',
  'nursing',
  'ot',
  'doctor_visit',
  'equipment',
  'misc',
  'cardiology',
  'icu',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const SERVICE_UNITS = ['per_visit', 'per_day', 'per_hour', 'per_unit'] as const;

export const VISIT_TYPES = ['new', 'follow_up', 'emergency', 'anc', 'paeds_vaccination'] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

export const DRUG_FORMS = [
  'tab',
  'cap',
  'syp',
  'inj',
  'drops',
  'cream',
  'pessary',
  'sachet',
  'inhaler',
  'other',
] as const;
export type DrugForm = (typeof DRUG_FORMS)[number];

export const DRUG_SCHEDULES = ['none', 'H', 'H1', 'X', 'G', 'NDPS'] as const;

export const LAB_DEPARTMENTS = [
  'haematology',
  'biochemistry',
  'serology',
  'microbiology',
  'clin_path',
  'hormones',
  'other',
] as const;
export type LabDepartment = (typeof LAB_DEPARTMENTS)[number];

export const LAB_RESULT_TYPES = ['numeric', 'text', 'option', 'culture', 'formula'] as const;

export const USG_CATEGORIES = [
  'obstetric',
  'gynae',
  'abdomen',
  'pelvis',
  'follicular',
  'doppler',
  'other',
] as const;
export type UsgCategory = (typeof USG_CATEGORIES)[number];

export const REASON_KINDS = ['discount', 'cancel', 'refund', 'stock_adjust', 'no_show'] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Departments with fixed codes in docs/04 §2; others may be added. */
export const DEPARTMENT_CODES = ['GYN', 'PAED', 'CARD', 'PATH', 'RAD', 'PHARM', 'ANES'] as const;

/** Master kinds as used by the admin UI routes (`/admin/masters/<kind>`). */
export const MASTER_KINDS = [
  'departments',
  'doctors',
  'services',
  'tariffs',
  'payers',
  'drugs',
  'lab-tests',
  'usg-procedures',
  'reason-codes',
] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

/** Rates, tariffs and payers need the finer `admin.tariff.manage`; the rest `admin.masters.manage`. */
export const MASTER_KIND_PERMISSION = {
  departments: 'admin.masters.manage',
  doctors: 'admin.masters.manage',
  services: 'admin.masters.manage',
  tariffs: 'admin.tariff.manage',
  payers: 'admin.tariff.manage',
  drugs: 'admin.masters.manage',
  'lab-tests': 'admin.masters.manage',
  'usg-procedures': 'admin.masters.manage',
  'reason-codes': 'admin.masters.manage',
} as const satisfies Record<MasterKind, 'admin.masters.manage' | 'admin.tariff.manage'>;

// --- field primitives -------------------------------------------------------------------------

const text = (max: number, min = 2, tier: 'always' | 'strict' = 'always') =>
  z
    .string()
    .trim()
    .min(min, 'validation.required')
    .max(max, 'validation.tooLong')
    .refine(...noForbiddenTerms(tier));

/** Optional free text: blank becomes `null`. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'validation.tooLong')
    .refine(...noForbiddenTerms('always'))
    .nullish()
    .transform((v) => v || null);

const optUuid = z
  .union([uuidSchema, z.literal('')])
  .nullish()
  .transform((v) => v || null);

const optDate = z
  .union([isoDateSchema, z.literal('')])
  .nullish()
  .transform((v) => v || null);

const sortOrder = z.number().int().min(0).max(9999).default(100);

const codeSchema = (max = 24, tier: 'always' | 'strict' = 'always') =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(new RegExp(`^[A-Z0-9][A-Z0-9._-]{1,${max - 1}}$`), 'validation.code')
    .refine(...noForbiddenTerms(tier));

/** Short code staff type to find an item fast (`PCM`, `NT`). Optional. */
const shortCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(16, 'validation.tooLong')
  .refine(...noForbiddenTerms('always'))
  .nullish()
  .transform((v) => v || null);

export const cancelMasterSchema = z.object({
  id: uuidSchema,
  reason: z.string().trim().min(3, 'validation.reason').max(200, 'validation.tooLong'),
});
export const restoreMasterSchema = z.object({ id: uuidSchema });

export const masterListSchema = z.object({
  search: z.string().trim().max(60).optional(),
  includeCancelled: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  /** Opaque keyset cursor from the previous page (browse mode only). */
  cursor: z.string().max(400).nullish(),
});
export type MasterListInput = z.input<typeof masterListSchema>;

// --- per-master input schemas -----------------------------------------------------------------

export const departmentInputSchema = z.object({
  name: text(80),
  nameHi: optText(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,11}$/, 'validation.code'),
  isClinical: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder,
});
export const departmentUpdateSchema = departmentInputSchema.extend({ id: uuidSchema });

export const doctorInputSchema = z.object({
  userId: optUuid,
  departmentId: uuidSchema,
  displayName: text(80),
  displayNameHi: optText(80),
  qualifications: optText(120),
  registrationCouncil: optText(80),
  registrationNo: optText(40),
  isVisiting: z.boolean().default(false),
  opdDays: z.array(z.enum(WEEKDAYS)).max(7).default([]),
  isActive: z.boolean().default(true),
});
export const doctorUpdateSchema = doctorInputSchema.extend({ id: uuidSchema });

/** Fee, validity and free follow-ups for one visit type of one doctor (docs/04 §2, docs/10 §4). */
export const consultationRuleInputSchema = z.object({
  doctorId: uuidSchema,
  visitType: z.enum(VISIT_TYPES),
  /** The consultation service whose rate in the payer's tariff is the fee. */
  serviceId: uuidSchema,
  /** Null: use setting `opd.followUpValidityDays` (default 7, docs/40 Q6). */
  followUpValidityDays: z.number().int().min(0).max(365).nullish().default(null),
  /** Null: use setting `opd.freeFollowUps` (default 1, docs/40 Q6). */
  freeFollowUpsCount: z.number().int().min(0).max(20).nullish().default(null),
});

export const payerInputSchema = z.object({
  name: text(80),
  type: z.enum(PAYER_TYPES),
  code: codeSchema(),
  contact: optText(200),
  creditDays: z.number().int().min(0).max(365).default(0),
  requiresPreauth: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export const payerUpdateSchema = payerInputSchema.extend({ id: uuidSchema });

export const tariffInputSchema = z
  .object({
    name: text(80),
    /** Null: the default tariff used when the encounter's payer has none (docs/04 §2). */
    payerId: optUuid,
    effectiveFrom: isoDateSchema,
    effectiveTo: optDate,
    isActive: z.boolean().default(true),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    path: ['effectiveTo'],
    message: 'validation.dateOrder',
  });
export const tariffUpdateSchema = tariffInputSchema.and(z.object({ id: uuidSchema }));

const serviceFields = {
  code: codeSchema(32),
  name: text(120),
  nameHi: optText(120),
  shortCode: shortCodeSchema,
  category: z.enum(SERVICE_CATEGORIES),
  departmentId: optUuid,
  sacCode: z
    .union([hsnSacSchema, z.literal('')])
    .nullish()
    .transform((v) => v || null),
  defaultGstRateBp: gstRateBpSchema.default(0),
  isExempt: z.boolean().default(true),
  unit: z.enum(SERVICE_UNITS).default('per_visit'),
  linkedLabTestId: optUuid,
  linkedUsgProcedureId: optUuid,
  isActive: z.boolean().default(true),
};
/** Exempt healthcare services carry no GST (docs/12 §7.5); taxable ones need a rate. */
const serviceRefine = (v: { isExempt: boolean; defaultGstRateBp: number }) =>
  !v.isExempt || v.defaultGstRateBp === 0;
export const serviceInputSchema = z.object(serviceFields).refine(serviceRefine, {
  path: ['defaultGstRateBp'],
  message: 'validation.exemptNoGst',
});
export const serviceUpdateSchema = z
  .object({ ...serviceFields, id: uuidSchema })
  .refine(serviceRefine, { path: ['defaultGstRateBp'], message: 'validation.exemptNoGst' });

export const serviceRateInputSchema = z.object({
  serviceId: uuidSchema,
  tariffId: uuidSchema,
  /** IPD rates that vary by room (docs/04 §2); null for everything else. */
  roomCategoryId: optUuid,
  ratePaise: nonNegativePaiseSchema,
  effectiveFrom: isoDateSchema,
});

const drugFields = {
  brandName: text(120),
  genericName: optText(160),
  shortCode: shortCodeSchema,
  strength: optText(60),
  form: z.enum(DRUG_FORMS).default('tab'),
  manufacturer: optText(120),
  hsnCode: z
    .union([hsnSacSchema, z.literal('')])
    .nullish()
    .transform((v) => v || null),
  gstRateBp: gstRateBpSchema.default(0),
  schedule: z.enum(DRUG_SCHEDULES).default('none'),
  isStocked: z.boolean().default(true),
  defaultDoseText: optText(120),
  packSize: optText(40),
  isActive: z.boolean().default(true),
};
export const drugInputSchema = z.object(drugFields);
export const drugUpdateSchema = z.object({ ...drugFields, id: uuidSchema });

const labTestFields = {
  code: codeSchema(24),
  name: text(120),
  shortCode: shortCodeSchema,
  department: z.enum(LAB_DEPARTMENTS),
  sampleType: optText(40),
  container: optText(40),
  method: optText(80),
  unit: optText(30),
  resultType: z.enum(LAB_RESULT_TYPES).default('numeric'),
  decimals: z.number().int().min(0).max(6).nullish().default(null),
  tatHours: z.number().int().min(0).max(720).nullish().default(null),
  isOutsourced: z.boolean().default(false),
  outsourceLab: optText(80),
  isActive: z.boolean().default(true),
};
export const labTestInputSchema = z.object(labTestFields);
export const labTestUpdateSchema = z.object({ ...labTestFields, id: uuidSchema });

const usgFields = {
  code: codeSchema(24, 'strict'),
  name: text(120, 2, 'strict'),
  category: z.enum(USG_CATEGORIES),
  /** Legal gating default: Form F whenever the woman is pregnant (docs/33 §3, docs/13). */
  requiresFormFIfPregnant: z.boolean().default(true),
  isActive: z.boolean().default(true),
};
export const usgProcedureInputSchema = z.object(usgFields);
export const usgProcedureUpdateSchema = z.object({ ...usgFields, id: uuidSchema });

const reasonFields = {
  kind: z.enum(REASON_KINDS),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, 'validation.roleKey'),
  label: text(80),
  labelHi: optText(80),
  isActive: z.boolean().default(true),
};
export const reasonCodeInputSchema = z.object(reasonFields);
export const reasonCodeUpdateSchema = z.object({ ...reasonFields, id: uuidSchema });

/**
 * Normalised search text stored (generated) per master row for trigram search. The DB function
 * `hmis_search_text` does the same lower-casing and punctuation folding.
 */
export function searchQueryText(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}
