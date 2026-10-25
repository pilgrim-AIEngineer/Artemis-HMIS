import {
  Building2,
  FlaskConical,
  HandCoins,
  IdCard,
  ListChecks,
  Pill,
  ScanLine,
  Stethoscope,
  Tags,
  type LucideIcon,
} from 'lucide-react';
import {
  bpToPercent,
  departmentInputSchema,
  doctorInputSchema,
  DRUG_FORMS,
  DRUG_SCHEDULES,
  drugInputSchema,
  LAB_DEPARTMENTS,
  LAB_RESULT_TYPES,
  labTestInputSchema,
  payerInputSchema,
  PAYER_TYPES,
  reasonCodeInputSchema,
  REASON_KINDS,
  SERVICE_CATEGORIES,
  SERVICE_UNITS,
  serviceInputSchema,
  tariffInputSchema,
  USG_CATEGORIES,
  usgProcedureInputSchema,
  VISIT_TYPES,
  WEEKDAYS,
  type MasterKind,
} from '@hmis/shared';
import type { ZodType } from 'zod';
import type { LookupName } from './api';

/** Option lists for `select` fields; labels live in `admin.masters.enums.<group>.<value>`. */
export const ENUMS = {
  serviceCategory: SERVICE_CATEGORIES,
  serviceUnit: SERVICE_UNITS,
  payerType: PAYER_TYPES,
  drugForm: DRUG_FORMS,
  drugSchedule: DRUG_SCHEDULES,
  labDepartment: LAB_DEPARTMENTS,
  labResultType: LAB_RESULT_TYPES,
  usgCategory: USG_CATEGORIES,
  reasonKind: REASON_KINDS,
  visitType: VISIT_TYPES,
  weekday: WEEKDAYS,
} as const satisfies Record<string, readonly string[]>;
export type EnumGroup = keyof typeof ENUMS;

export type FieldType =
  'text' | 'integer' | 'select' | 'checkbox' | 'date' | 'gstPercent' | 'weekdays';

export interface FieldDef {
  name: string;
  type: FieldType;
  /** Static options (labels from `enums.<group>`). */
  enum?: EnumGroup;
  /** Options loaded from the masters (departments, payers …). */
  from?: LookupName;
  /** Select may stay blank (stored as none). */
  optional?: boolean;
  required?: boolean;
  /** Integer fields: blank means "not set" (stored as null). */
  nullable?: boolean;
  /** `admin.masters.help.<key>` text under the field. */
  help?: string;
  /** Typed in capitals (codes). */
  upper?: boolean;
  /** Fixed once created (codes other modules refer to). */
  lockedOnEdit?: boolean;
  wide?: boolean;
}

export interface ColumnDef {
  /** Row key; also the `admin.masters.fields.<key>` header. */
  key: string;
  /** Rendering hint; default shows the text value. */
  as?: 'enum' | 'bool' | 'lookup' | 'gst' | 'days' | 'code';
  enum?: EnumGroup;
  from?: LookupName;
  /** Hidden below the `md` breakpoint (10-inch tablets keep the key columns). */
  secondary?: boolean;
}

export interface FilterDef {
  name: string;
  enum: EnumGroup;
}

export interface MasterDef {
  kind: MasterKind;
  icon: LucideIcon;
  /** Row field that names the record (dialog title, confirmations). */
  titleKey: string;
  schema: ZodType;
  fields: readonly FieldDef[];
  columns: readonly ColumnDef[];
  filters?: readonly FilterDef[];
  /** Initial values for "New". */
  defaults: Record<string, unknown>;
  /** Link to a detail screen (rates of a tariff). */
  detailHref?: (row: { id: string }) => string;
}

const f = {
  text: (name: string, o: Partial<FieldDef> = {}): FieldDef => ({ name, type: 'text', ...o }),
  integer: (name: string, o: Partial<FieldDef> = {}): FieldDef => ({ name, type: 'integer', ...o }),
  select: (name: string, o: Partial<FieldDef> = {}): FieldDef => ({ name, type: 'select', ...o }),
  check: (name: string, o: Partial<FieldDef> = {}): FieldDef => ({ name, type: 'checkbox', ...o }),
  date: (name: string, o: Partial<FieldDef> = {}): FieldDef => ({ name, type: 'date', ...o }),
};

export const MASTER_DEFS: Record<MasterKind, MasterDef> = {
  departments: {
    kind: 'departments',
    icon: Building2,
    titleKey: 'name',
    schema: departmentInputSchema,
    fields: [
      f.text('name', { required: true }),
      f.text('nameHi'),
      f.text('code', { required: true, upper: true, lockedOnEdit: true, help: 'deptCode' }),
      f.integer('sortOrder'),
      f.check('isClinical'),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'code', as: 'code' },
      { key: 'name' },
      { key: 'nameHi', secondary: true },
      { key: 'isClinical', as: 'bool', secondary: true },
    ],
    defaults: { isClinical: true, isActive: true, sortOrder: 100 },
  },
  doctors: {
    kind: 'doctors',
    icon: Stethoscope,
    titleKey: 'displayName',
    schema: doctorInputSchema,
    fields: [
      f.text('displayName', { required: true }),
      f.text('displayNameHi'),
      f.select('departmentId', { from: 'departments', required: true }),
      f.select('userId', { from: 'users', optional: true, help: 'doctorUser' }),
      f.text('qualifications', { wide: true }),
      f.text('registrationCouncil'),
      f.text('registrationNo'),
      { name: 'opdDays', type: 'weekdays', wide: true },
      f.check('isVisiting'),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'displayName' },
      { key: 'departmentId', as: 'lookup', from: 'departments' },
      { key: 'qualifications', secondary: true },
      { key: 'opdDays', as: 'days', secondary: true },
      { key: 'isVisiting', as: 'bool', secondary: true },
    ],
    filters: [],
    defaults: {
      isVisiting: false,
      isActive: true,
      opdDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    },
  },
  services: {
    kind: 'services',
    icon: HandCoins,
    titleKey: 'name',
    schema: serviceInputSchema,
    fields: [
      f.text('code', { required: true, upper: true, lockedOnEdit: true, help: 'serviceCode' }),
      f.text('shortCode', { upper: true, help: 'shortCode' }),
      f.text('name', { required: true, wide: true }),
      f.text('nameHi', { wide: true, help: 'nameHiBill' }),
      f.select('category', { enum: 'serviceCategory', required: true }),
      f.select('unit', { enum: 'serviceUnit', required: true }),
      f.select('departmentId', { from: 'departments', optional: true }),
      f.text('sacCode', { help: 'sacCode' }),
      f.check('isExempt', { help: 'isExempt' }),
      { name: 'defaultGstRateBp', type: 'gstPercent', help: 'gstPercent' },
      f.select('linkedLabTestId', { from: 'labTests', optional: true, help: 'linkedLab' }),
      f.select('linkedUsgProcedureId', { from: 'usgProcedures', optional: true }),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'code', as: 'code' },
      { key: 'name' },
      { key: 'category', as: 'enum', enum: 'serviceCategory' },
      { key: 'unit', as: 'enum', enum: 'serviceUnit', secondary: true },
      { key: 'defaultGstRateBp', as: 'gst', secondary: true },
    ],
    filters: [{ name: 'category', enum: 'serviceCategory' }],
    defaults: {
      category: 'procedure',
      unit: 'per_visit',
      isExempt: true,
      defaultGstRateBp: 0,
      isActive: true,
    },
  },
  tariffs: {
    kind: 'tariffs',
    icon: Tags,
    titleKey: 'name',
    schema: tariffInputSchema,
    fields: [
      f.text('name', { required: true, wide: true }),
      f.select('payerId', { from: 'payers', optional: true, help: 'tariffPayer' }),
      f.date('effectiveFrom', { required: true }),
      f.date('effectiveTo', { help: 'effectiveTo' }),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'name' },
      { key: 'payerId', as: 'lookup', from: 'payers' },
      { key: 'effectiveFrom' },
      { key: 'effectiveTo', secondary: true },
    ],
    defaults: { isActive: true, effectiveFrom: '' },
    detailHref: (row) => `/admin/masters/tariffs/${row.id}`,
  },
  payers: {
    kind: 'payers',
    icon: IdCard,
    titleKey: 'name',
    schema: payerInputSchema,
    fields: [
      f.text('name', { required: true, wide: true }),
      f.select('type', { enum: 'payerType', required: true }),
      f.text('code', { required: true, upper: true, lockedOnEdit: true }),
      f.text('contact', { wide: true }),
      f.integer('creditDays', { help: 'creditDays' }),
      f.check('requiresPreauth'),
      f.check('isActive', { help: 'payerActive' }),
    ],
    columns: [
      { key: 'name' },
      { key: 'code', as: 'code' },
      { key: 'type', as: 'enum', enum: 'payerType' },
      { key: 'requiresPreauth', as: 'bool', secondary: true },
    ],
    defaults: { type: 'other', creditDays: 0, requiresPreauth: false, isActive: false },
  },
  drugs: {
    kind: 'drugs',
    icon: Pill,
    titleKey: 'brandName',
    schema: drugInputSchema,
    fields: [
      f.text('brandName', { required: true, wide: true }),
      f.text('genericName', { wide: true }),
      f.text('shortCode', { upper: true, help: 'shortCode' }),
      f.text('strength'),
      f.select('form', { enum: 'drugForm', required: true }),
      f.text('manufacturer'),
      f.select('schedule', { enum: 'drugSchedule', required: true, help: 'schedule' }),
      f.text('hsnCode', { help: 'hsn' }),
      { name: 'gstRateBp', type: 'gstPercent', help: 'drugGst' },
      f.text('packSize'),
      f.text('defaultDoseText', { wide: true }),
      f.check('isStocked'),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'brandName' },
      { key: 'strength' },
      { key: 'form', as: 'enum', enum: 'drugForm' },
      { key: 'genericName', secondary: true },
      { key: 'schedule', as: 'enum', enum: 'drugSchedule', secondary: true },
    ],
    filters: [{ name: 'form', enum: 'drugForm' }],
    defaults: { form: 'tab', schedule: 'none', gstRateBp: 0, isStocked: true, isActive: true },
  },
  'lab-tests': {
    kind: 'lab-tests',
    icon: FlaskConical,
    titleKey: 'name',
    schema: labTestInputSchema,
    fields: [
      f.text('code', { required: true, upper: true, lockedOnEdit: true }),
      f.text('shortCode', { upper: true, help: 'shortCode' }),
      f.text('name', { required: true, wide: true }),
      f.select('department', { enum: 'labDepartment', required: true }),
      f.select('resultType', { enum: 'labResultType', required: true }),
      f.text('sampleType'),
      f.text('container'),
      f.text('method'),
      f.text('unit', { help: 'labUnit' }),
      f.integer('decimals', { nullable: true }),
      f.integer('tatHours', { nullable: true }),
      f.check('isOutsourced'),
      f.text('outsourceLab'),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'code', as: 'code' },
      { key: 'name' },
      { key: 'department', as: 'enum', enum: 'labDepartment' },
      { key: 'unit', secondary: true },
      { key: 'isOutsourced', as: 'bool', secondary: true },
    ],
    filters: [{ name: 'department', enum: 'labDepartment' }],
    defaults: {
      department: 'haematology',
      resultType: 'numeric',
      isOutsourced: false,
      isActive: true,
    },
  },
  'usg-procedures': {
    kind: 'usg-procedures',
    icon: ScanLine,
    titleKey: 'name',
    schema: usgProcedureInputSchema,
    fields: [
      f.text('code', { required: true, upper: true, lockedOnEdit: true }),
      f.select('category', { enum: 'usgCategory', required: true }),
      f.text('name', { required: true, wide: true }),
      f.check('requiresFormFIfPregnant', { help: 'formF' }),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'code', as: 'code' },
      { key: 'name' },
      { key: 'category', as: 'enum', enum: 'usgCategory' },
      { key: 'requiresFormFIfPregnant', as: 'bool' },
    ],
    filters: [{ name: 'category', enum: 'usgCategory' }],
    defaults: { category: 'obstetric', requiresFormFIfPregnant: true, isActive: true },
  },
  'reason-codes': {
    kind: 'reason-codes',
    icon: ListChecks,
    titleKey: 'label',
    schema: reasonCodeInputSchema,
    fields: [
      f.select('kind', { enum: 'reasonKind', required: true }),
      f.text('code', { required: true, lockedOnEdit: true, help: 'reasonCode' }),
      f.text('label', { required: true, wide: true }),
      f.text('labelHi', { wide: true }),
      f.check('isActive', { help: 'isActive' }),
    ],
    columns: [
      { key: 'kind', as: 'enum', enum: 'reasonKind' },
      { key: 'label' },
      { key: 'labelHi', secondary: true },
      { key: 'code', as: 'code', secondary: true },
    ],
    filters: [{ name: 'kind', enum: 'reasonKind' }],
    defaults: { kind: 'discount', isActive: true },
  },
};

/** Row → form values: nulls become blanks, GST stays in basis points. */
export function rowToForm(def: MasterDef, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const fld of def.fields) {
    const v = row[fld.name];
    out[fld.name] = v === null || v === undefined ? (fld.type === 'checkbox' ? false : '') : v;
  }
  if (typeof row.id === 'string') out.id = row.id;
  return out;
}

export const gstLabel = (bp: unknown): string =>
  typeof bp === 'number' ? `${bpToPercent(bp)}%` : '—';
