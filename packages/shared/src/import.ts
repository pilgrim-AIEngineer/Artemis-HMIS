/**
 * Excel / CSV import (MIG-01, docs/10 §9, docs/33 §9): the pure half. Reads a messy real-world
 * spreadsheet grid into staged rows and turns each row into a validated registration or rate
 * input, collecting every problem (never throwing on the first). No database here; the db package
 * stages, de-duplicates and commits.
 *
 * Messy-file tolerance (all covered by tests): title rows above the header, blank rows, header
 * spellings ("Mob. No", "Patient Name"), dd/mm/yyyy and Excel-serial dates, `+91` / two numbers in
 * one mobile cell, "W/o Ramesh" in the guardian column, "28 yrs" ages, "₹ 1,200/-" rates.
 * Money stays exact: rupee text becomes integer paise without floats (AGENTS.md rule 1).
 */
import { z } from 'zod';
import {
  addDays,
  compareDates,
  isValidCalendarDate,
  parseAgeInput,
  parseIsoDate,
  toIsoDate,
} from './dates';
import type { CalendarDate } from './fy';
import {
  BLOOD_GROUPS,
  createPatientSchema,
  GUARDIAN_RELATIONS,
  MOBILE_OWNER_RELATIONS,
  type PATIENT_SEXES,
  resolveDob,
  titleCaseName,
  type CreatePatient,
  type CreatePatientInput,
} from './patients';
import { rupeesToPaise, type Paise } from './money';
import { SERVICE_CATEGORIES, SERVICE_UNITS } from './masters';

export const IMPORT_KINDS = ['patients', 'services_rates'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Upload limits: a 40-bed hospital's old register fits comfortably. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
/** Rows committed per transaction (the reception counter shares the UHID series, so keep short). */
export const IMPORT_COMMIT_BATCH = 200;
/** Header search window: title rows above the real header are skipped. */
const HEADER_SCAN_ROWS = 25;

/** What the user chose for a batch (stored with it, so a remap or a resume uses the same). */
export const importOptionsSchema = z.object({
  /** Patients: import rows without a mobile instead of reporting them as errors. */
  allowMissingMobile: z.boolean().default(false),
  /** Patients: `import` also creates rows that look like an existing / earlier patient. */
  duplicates: z.enum(['skip', 'import']).default('skip'),
  /** Rates: effective date for rows that have none. */
  defaultEffectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
});
export type ImportOptions = z.output<typeof importOptionsSchema>;

/** Duplicate verdicts the user may override with `duplicates: 'import'` (a same-looking person). */
export const OVERRIDABLE_DUPLICATE_CODES = ['duplicateExisting', 'duplicateInFile'] as const;

export const IMPORT_ROW_STATUSES = [
  'ok',
  'error',
  'duplicate',
  'unchanged',
  'committed',
  'failed',
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export interface RowIssue {
  /** Template column key the problem belongs to (`mobile`, `rate_inr`, …) or `row`. */
  field: string;
  /** i18n key suffix under `import.issues.*`. */
  code: string;
}

// ---------------------------------------------------------------- CSV reading

/** Bytes of a CSV file → text. Handles BOM, UTF-16 (Excel "Unicode text"), and Windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    // Excel "CSV (Comma delimited)" on Windows is Windows-1252.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Picks the delimiter that splits the first non-empty lines most consistently. */
function sniffDelimiter(text: string): string {
  const sample = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, 10);
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0;
    for (const line of sample) {
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === d && !inQuotes) count++;
      }
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 reader: quoted fields, doubled quotes, embedded newlines, CR / LF / CRLF. */
export function parseCsv(text: string): string[][] {
  const delimiter = sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delimiter) endField();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') endRow();
    else field += ch;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// ---------------------------------------------------------------- headers and mapping

/** `"Mob. No"` → `mob_no`; letters of any script and digits survive. */
export function normaliseHeader(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

const alias = (key: string, ...names: string[]): [string, string][] =>
  [key, ...names].map((n) => [normaliseHeader(n), key]);

const PATIENT_ALIASES = new Map<string, string>([
  ...alias(
    'old_uhid',
    'old reg no',
    'old registration no',
    'reg no',
    'registration number',
    'uhid',
  ),
  ...alias('old_uhid', 'opd no', 'opd number', 'old id', 'patient id', 'regn no', 'reg. no.'),
  ...alias('first_name', 'firstname', 'first', 'given name'),
  ...alias('middle_name', 'middlename', 'middle'),
  ...alias('last_name', 'lastname', 'surname', 'family name', 'उपनाम'),
  ...alias('full_name', 'name', 'patient name', 'patient', 'naam', 'नाम', 'मरीज का नाम'),
  ...alias('sex', 'gender', 'm/f', 'लिंग'),
  ...alias('dob', 'date of birth', 'birth date', 'd.o.b', 'जन्म तिथि'),
  ...alias('age_years', 'age', 'age yrs', 'age (years)', 'आयु', 'उम्र'),
  ...alias('mobile', 'mobile no', 'mobile number', 'mob', 'mob no', 'phone', 'phone no', 'contact'),
  ...alias('mobile', 'contact no', 'contact number', 'cell', 'whatsapp', 'मोबाइल', 'फोन'),
  ...alias('relation_to_mobile_owner', 'relation with mobile owner', 'mobile owner'),
  ...alias('guardian_name', 'guardian', 'husband name', 'father name', 'husband/father name'),
  ...alias('guardian_name', 'father/husband name', 'w/o', 's/o', 'attendant', 'पति/पिता का नाम'),
  ...alias('guardian_relation', 'guardian relation', 'relation'),
  ...alias('address_line', 'address', 'addr', 'पता'),
  ...alias('locality', 'village', 'area', 'city', 'town', 'गाँव', 'गांव'),
  ...alias('district', 'dist', 'जिला'),
  ...alias('state', 'राज्य'),
  ...alias('pincode', 'pin', 'pin code', 'zip', 'postal code'),
  ...alias('blood_group', 'blood', 'blood grp', 'bg', 'रक्त समूह'),
]);

const RATE_ALIASES = new Map<string, string>([
  ...alias('service_code', 'code', 'item code', 'service id'),
  ...alias('service_name', 'service', 'name', 'item', 'item name', 'particulars', 'description'),
  ...alias('service_name_hi', 'hindi name', 'name hindi', 'name (hindi)'),
  ...alias('category', 'type', 'group', 'service category'),
  ...alias('department_code', 'department', 'dept', 'dept code'),
  ...alias('unit', 'per', 'charged per'),
  ...alias('sac_code', 'sac', 'hsn', 'hsn/sac'),
  ...alias('gst_rate_percent', 'gst', 'gst %', 'gst rate', 'tax %'),
  ...alias('tariff_name', 'tariff', 'rate card', 'price list', 'payer'),
  ...alias('room_category', 'room', 'room type', 'ward'),
  ...alias(
    'rate_inr',
    'rate',
    'price',
    'amount',
    'charges',
    'charge',
    'fee',
    'rate (rs)',
    'rate ₹',
  ),
  ...alias(
    'effective_from',
    'effective',
    'effective date',
    'w.e.f',
    'wef',
    'from date',
    'with effect from',
  ),
]);

const ALIASES: Record<ImportKind, Map<string, string>> = {
  patients: PATIENT_ALIASES,
  services_rates: RATE_ALIASES,
};

/** Target columns a source column can be mapped to (what the wizard's dropdown offers). */
export const IMPORT_TARGETS: Record<ImportKind, readonly string[]> = {
  patients: [
    'old_uhid',
    'first_name',
    'middle_name',
    'last_name',
    'full_name',
    'sex',
    'dob',
    'age_years',
    'mobile',
    'relation_to_mobile_owner',
    'guardian_name',
    'guardian_relation',
    'address_line',
    'locality',
    'district',
    'state',
    'pincode',
    'blood_group',
  ],
  services_rates: [
    'service_code',
    'service_name',
    'service_name_hi',
    'category',
    'department_code',
    'unit',
    'sac_code',
    'gst_rate_percent',
    'tariff_name',
    'room_category',
    'rate_inr',
    'effective_from',
  ],
};

/** Target for one source header, or null when it is not recognised. */
export function matchHeader(kind: ImportKind, header: string): string | null {
  return ALIASES[kind].get(normaliseHeader(header)) ?? null;
}

/** One target per source column (`null` = ignored); a target used twice keeps the first column. */
export function autoMap(kind: ImportKind, headers: readonly string[]): (string | null)[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const t = matchHeader(kind, h);
    if (!t || used.has(t)) return null;
    used.add(t);
    return t;
  });
}

export type Cell = string;
export interface StagedSheet {
  headers: string[];
  /** 1-based row numbers in the source file, aligned with `rows`. */
  sourceRows: number[];
  rows: Cell[][];
  mapping: (string | null)[];
}

export class ImportFileError extends Error {
  constructor(readonly code: 'noHeader' | 'empty' | 'tooManyRows' | 'unreadable') {
    super(code);
    this.name = 'ImportFileError';
  }
}

/**
 * Grid of cell text → staged sheet: finds the header row among the first rows (the best match
 * with the known column names, at least two), drops blank rows, pads short rows.
 */
export function stageGrid(kind: ImportKind, grid: readonly (readonly Cell[])[]): StagedSheet {
  let headerAt = -1;
  let bestScore = 1;
  grid.slice(0, HEADER_SCAN_ROWS).forEach((row, i) => {
    const score = new Set(row.map((c) => matchHeader(kind, c)).filter(Boolean)).size;
    if (score > bestScore) {
      bestScore = score;
      headerAt = i;
    }
  });
  if (headerAt < 0) {
    throw new ImportFileError(grid.some((r) => r.some((c) => c.trim())) ? 'noHeader' : 'empty');
  }
  const width = Math.max(...grid.slice(headerAt).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => (grid[headerAt]![i] ?? '').trim());
  const sourceRows: number[] = [];
  const rows: Cell[][] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const r = grid[i]!;
    if (r.every((c) => c.trim() === '')) continue;
    sourceRows.push(i + 1);
    rows.push(Array.from({ length: width }, (_, j) => r[j] ?? ''));
  }
  if (rows.length === 0) throw new ImportFileError('empty');
  if (rows.length > MAX_IMPORT_ROWS) throw new ImportFileError('tooManyRows');
  return { headers, sourceRows, rows, mapping: autoMap(kind, headers) };
}

/** Row cells → `{ target: text }` through the mapping (blank cells omitted). */
export function mappedRow(
  raw: readonly Cell[],
  mapping: readonly (string | null)[],
): Record<string, string> {
  const out: Record<string, string> = {};
  mapping.forEach((target, i) => {
    if (!target || out[target] !== undefined) return;
    const v = cleanText(raw[i] ?? '');
    if (v) out[target] = v;
  });
  return out;
}

// ---------------------------------------------------------------- cell coercion

const PLACEHOLDERS = new Set(['-', '--', '---', 'na', 'n/a', 'nil', 'null', 'none', '?', '.', 'x']);

/** Trimmed single-line text; invisible characters and "N/A"-style placeholders become ''. */
export function cleanText(s: string): string {
  const t = s
    .normalize('NFC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
  return PLACEHOLDERS.has(t.toLowerCase()) ? '' : t;
}

const LEADING_TITLE = /^(?:smt|mrs|mr|ms|miss|shri|shrimati|sri|kumari|km)\b\.?\s+/i;

/** "  smt. sunita DEVI " → "Sunita Devi". */
export function cleanPersonName(s: string): string {
  return titleCaseName(cleanText(s).replace(LEADING_TITLE, ''));
}

export function parseSexCell(s: string): (typeof PATIENT_SEXES)[number] | null {
  const t = cleanText(s).toLowerCase().replace(/[.\s]/g, '');
  if (['f', 'female', 'woman', 'w', 'mahila', 'महिला', 'स्त्री', 'औरत'].includes(t)) return 'F';
  if (['m', 'male', 'man', 'purush', 'पुरुष', 'आदमी'].includes(t)) return 'M';
  if (['o', 'other', 'others', 't', 'transgender', 'third', 'अन्य'].includes(t)) return 'O';
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 1900-system Excel serial → calendar date (serial 1 = 1900-01-01; the 1900 leap bug included). */
function fromExcelSerial(n: number): CalendarDate | null {
  if (!Number.isInteger(n) || n < 1 || n > 80_000) return null;
  const base: CalendarDate = { year: 1899, month: 12, day: 30 };
  return addDays(base, n);
}

/** Two-digit years: the latest century that does not put the date in the future. */
function fullYear(yy: number, today: CalendarDate): number {
  const y = 2000 + yy;
  return y > today.year ? 1900 + yy : y;
}

/**
 * A date as people write it: `2026-07-01`, `01/07/1994`, `1-7-94`, `01.07.1994`, `1 Jul 1994`,
 * `July 1, 1994`, or an Excel serial (`34515`). Indian order (day first) for slashes. Null when
 * unreadable or not a real calendar date.
 */
export function parseDateCell(raw: string, today: CalendarDate): CalendarDate | null {
  const s = cleanText(raw).replace(/\s*(?:\d{1,2}:\d{2}.*)$/, '');
  if (!s) return null;
  let d: CalendarDate | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) {
    d = { year: +m[1]!, month: +m[2]!, day: +m[3]! };
  } else if ((m = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4}|\d{2})$/.exec(s))) {
    const y = m[3]!.length === 2 ? fullYear(+m[3]!, today) : +m[3]!;
    d = { year: y, month: +m[2]!, day: +m[1]! };
  } else if ((m = /^(\d{1,2})[-/.\s]*([a-z]{3,9})[-/.,\s]*(\d{4}|\d{2})$/i.exec(s))) {
    const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    const y = m[3]!.length === 2 ? fullYear(+m[3]!, today) : +m[3]!;
    if (mon >= 0) d = { year: y, month: mon + 1, day: +m[1]! };
  } else if ((m = /^([a-z]{3,9})[-/.\s]+(\d{1,2})[,\s]+(\d{4})$/i.exec(s))) {
    const mon = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (mon >= 0) d = { year: +m[3]!, month: mon + 1, day: +m[2]! };
  } else if (/^\d{4,5}$/.test(s)) {
    d = fromExcelSerial(Number(s));
  }
  return d && isValidCalendarDate(d) ? d : null;
}

/**
 * Age text → the input `resolveDob` understands (`28`, `6m`, `15d`). Takes the leading unit:
 * `28 yrs`, `28Y 3M` → 28 years; `6 months`; `10 days`; `28.5` → 28.
 */
export function parseAgeCell(raw: string): string | null {
  const s = cleanText(raw).toLowerCase();
  let m: RegExpExecArray | null;
  if (
    (m =
      /^(\d{1,3})(?:\.\d+)?\s*(?:y|yr|yrs|year|years|वर्ष|साल)?(?:\s*\d{1,2}\s*(?:m|mon|mth|months?))?$/.exec(
        s,
      ))
  ) {
    return parseAgeInput(m[1]!) ? m[1]! : null;
  }
  if ((m = /^(\d{1,4})\s*(?:m|mon|mth|months?|महीने?)$/.exec(s))) {
    return parseAgeInput(`${m[1]}m`) ? `${m[1]}m` : null;
  }
  if ((m = /^(\d{1,4})\s*(?:d|days?|दिन)$/.exec(s))) {
    return parseAgeInput(`${m[1]}d`) ? `${m[1]}d` : null;
  }
  return null;
}

/**
 * Mobile cell → `{ mobile, alt }`. Strips `+91`/`0`, spaces and a trailing `.0` (numbers saved as
 * floats); a second number after `/ , ; &` or "or" becomes the alternate. `bad` is true when text
 * was there but no valid mobile could be read.
 */
export function parseMobileCell(raw: string): {
  mobile: string | null;
  alt: string | null;
  bad: boolean;
} {
  const s = cleanText(raw);
  if (!s) return { mobile: null, alt: null, bad: false };
  const valid: string[] = [];
  for (const part of s.split(/[/,;&]|\bor\b|\band\b/i)) {
    let d = part.replace(/\.0+$/, '').replace(/[\s\-().]/g, '');
    if (/^\+?91\d{10}$/.test(d)) d = d.replace(/^\+?91/, '');
    else if (/^0\d{10}$/.test(d)) d = d.slice(1);
    if (/^[6-9]\d{9}$/.test(d) && !valid.includes(d)) valid.push(d);
  }
  // "98765 43210" split on nothing; but "9876543210 9123456789" (space separated) is two numbers.
  if (valid.length === 0) {
    const spaced = s
      .match(/(?:\+?91[\s-]?)?[6-9]\d{9}/g)
      ?.map((x) => x.replace(/\D/g, '').slice(-10));
    for (const d of spaced ?? []) if (!valid.includes(d)) valid.push(d);
  }
  return { mobile: valid[0] ?? null, alt: valid[1] ?? null, bad: valid.length === 0 };
}

export function parseBloodGroup(raw: string): (typeof BLOOD_GROUPS)[number] | null {
  const m = /^(ab|a|b|o)\s*(\+ve|-ve|\+|-|pos(?:itive)?|neg(?:ative)?|ve\+|ve-)?$/i.exec(
    cleanText(raw).replace(/\s+/g, ' '),
  );
  if (!m?.[2]) return null;
  const sign = /^(\+|pos|ve\+)/i.test(m[2]) ? '+' : '-';
  const g = `${m[1]!.toUpperCase()}${sign}`;
  return (BLOOD_GROUPS as readonly string[]).includes(g)
    ? (g as (typeof BLOOD_GROUPS)[number])
    : null;
}

const GUARDIAN_PREFIXES: [RegExp, (typeof GUARDIAN_RELATIONS)[number]][] = [
  [/^(?:w\s*\/\s*o|wife\s+of)\b\.?\s*/i, 'husband'],
  [/^(?:d\s*\/\s*o|daughter\s+of|s\s*\/\s*o|son\s+of)\b\.?\s*/i, 'father'],
  [/^(?:c\s*\/\s*o|care\s+of)\b\.?\s*/i, 'other'],
];

/** "W/o Ramesh Verma" → husband "Ramesh Verma"; plain names pass through. */
export function parseGuardianCell(raw: string): {
  name: string | null;
  relation: (typeof GUARDIAN_RELATIONS)[number] | null;
} {
  let s = cleanText(raw);
  let relation: (typeof GUARDIAN_RELATIONS)[number] | null = null;
  for (const [re, rel] of GUARDIAN_PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, '');
      relation = rel;
      break;
    }
  }
  const name = cleanPersonName(s);
  return { name: name || null, relation: name ? relation : null };
}

const lowerEnum = <T extends string>(values: readonly T[], raw: string | undefined): T | null => {
  const t = cleanText(raw ?? '').toLowerCase();
  return (values as readonly string[]).includes(t) ? (t as T) : null;
};

// ---------------------------------------------------------------- patient rows

export interface PatientImportOptions {
  /** Import rows without a mobile (reason "Not in old register"); default false (template: required). */
  allowMissingMobile: boolean;
}
export const DEFAULT_PATIENT_OPTIONS: PatientImportOptions = { allowMissingMobile: false };
export const NO_MOBILE_IMPORT_REASON = 'Not in old register';

export interface ParsedPatientRow {
  input: CreatePatient;
  oldUhid: string | null;
}

export type RowResult<T> =
  | { ok: true; value: T; warnings: RowIssue[] }
  | { ok: false; errors: RowIssue[]; warnings: RowIssue[] };

/** Splits "Sunita Devi Verma" into first / middle / last (first word, last word, rest between). */
function splitFullName(full: string) {
  const w = full.split(' ').filter(Boolean);
  if (w.length === 1) return { first: w[0]!, middle: '', last: '' };
  return { first: w[0]!, middle: w.slice(1, -1).join(' '), last: w[w.length - 1]! };
}

/** Validates one patient row (already passed through `mappedRow`). `today` is the IST date. */
export function validatePatientRow(
  cells: Record<string, string>,
  opts: PatientImportOptions,
  today: CalendarDate,
): RowResult<ParsedPatientRow> {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const err = (field: string, code: string) => errors.push({ field, code });
  const warn = (field: string, code: string) => warnings.push({ field, code });

  // Name: separate columns win; a single "Name" column is split.
  let first = cleanPersonName(cells.first_name ?? '');
  let middle = cleanPersonName(cells.middle_name ?? '');
  let last = cleanPersonName(cells.last_name ?? '');
  if (!first && cells.full_name) {
    const s = splitFullName(cleanPersonName(cells.full_name));
    first = s.first;
    middle = middle || s.middle;
    last = last || s.last;
  }
  if (!first) err(cells.full_name !== undefined ? 'full_name' : 'first_name', 'nameRequired');

  const sex = cells.sex ? parseSexCell(cells.sex) : null;
  if (!sex) err('sex', cells.sex ? 'sexInvalid' : 'sexRequired');

  // DOB wins over age; an unreadable DOB falls back to a usable age.
  let dob: string | undefined;
  let age: string | undefined;
  const ageText = cells.age_years ? parseAgeCell(cells.age_years) : null;
  if (cells.dob) {
    const d = parseDateCell(cells.dob, today);
    const resolved = d ? resolveDob({ dob: toIsoDate(d) }, today) : null;
    if (resolved) dob = resolved.dob;
    else if (ageText) {
      age = ageText;
      warn('dob', 'dobIgnored');
    } else err('dob', d ? 'dobOutOfRange' : 'dobInvalid');
  }
  if (!dob && !age) {
    if (cells.age_years && !ageText) err('age_years', 'ageInvalid');
    else if (ageText) age = ageText;
    else if (!cells.dob) err('age_years', 'ageRequired');
  }
  if (age && !resolveDob({ age }, today)) err('age_years', 'ageInvalid');

  const m = parseMobileCell(cells.mobile ?? '');
  const mobile: string | undefined = m.mobile ?? undefined;
  let noMobileReason: string | undefined;
  if (m.bad) err('mobile', 'mobileInvalid');
  else if (!mobile) {
    if (opts.allowMissingMobile) {
      noMobileReason = NO_MOBILE_IMPORT_REASON;
      warn('mobile', 'mobileMissing');
    } else err('mobile', 'mobileRequired');
  }

  const guardian = cells.guardian_name ? parseGuardianCell(cells.guardian_name) : null;
  const explicitRelation = lowerEnum(GUARDIAN_RELATIONS, cells.guardian_relation);
  if (cells.guardian_relation && !explicitRelation) warn('guardian_relation', 'relationIgnored');
  const ownerRelation = lowerEnum(MOBILE_OWNER_RELATIONS, cells.relation_to_mobile_owner);
  if (cells.relation_to_mobile_owner && !ownerRelation) {
    warn('relation_to_mobile_owner', 'relationIgnored');
  }

  let pincode: string | undefined;
  if (cells.pincode) {
    const p = cells.pincode.replace(/[\s.]/g, '').replace(/^(\d{6})0+$/, '$1');
    if (/^[1-9]\d{5}$/.test(p)) pincode = p;
    else warn('pincode', 'pincodeIgnored');
  }
  let bloodGroup: (typeof BLOOD_GROUPS)[number] | undefined;
  if (cells.blood_group) {
    bloodGroup = parseBloodGroup(cells.blood_group) ?? undefined;
    if (!bloodGroup) warn('blood_group', 'bloodGroupIgnored');
  }

  if (errors.length) return { ok: false, errors, warnings };

  const candidate: CreatePatientInput = {
    firstName: first,
    middleName: middle || undefined,
    lastName: last || undefined,
    sex: sex!,
    ...(dob ? { dob } : { age }),
    mobile,
    altMobile: m.alt && m.alt !== mobile ? m.alt : undefined,
    noMobileReason,
    relationToMobileOwner: ownerRelation ?? undefined,
    guardianName: guardian?.name ?? undefined,
    guardianRelation: explicitRelation ?? guardian?.relation ?? undefined,
    addressLine: cells.address_line,
    localityName: cells.locality ? titleCaseName(cells.locality) : undefined,
    district: cells.district ? titleCaseName(cells.district) : undefined,
    state: cells.state ? titleCaseName(cells.state) : undefined,
    pincode,
    bloodGroup,
  };
  const parsed = createPatientSchema.safeParse(candidate);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'row');
      if (!seen.has(field)) {
        seen.add(field);
        err(SCHEMA_FIELD_TO_COLUMN[field] ?? 'row', 'invalid');
      }
    }
    return { ok: false, errors, warnings };
  }
  const oldUhid = cells.old_uhid ? cleanText(cells.old_uhid).slice(0, 40) : null;
  return { ok: true, value: { input: parsed.data, oldUhid: oldUhid || null }, warnings };
}

const SCHEMA_FIELD_TO_COLUMN: Record<string, string> = {
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  altMobile: 'mobile',
  guardianName: 'guardian_name',
  addressLine: 'address_line',
  localityName: 'locality',
  age: 'age_years',
  bloodGroup: 'blood_group',
  relationToMobileOwner: 'relation_to_mobile_owner',
  guardianRelation: 'guardian_relation',
  district: 'district',
  state: 'state',
  pincode: 'pincode',
  sex: 'sex',
  dob: 'dob',
};

// ---------------------------------------------------------------- rate rows

export interface RateImportOptions {
  /** `YYYY-MM-DD` used when a row has no effective date; null = such rows are errors. */
  defaultEffectiveFrom: string | null;
}
export const DEFAULT_RATE_OPTIONS: RateImportOptions = { defaultEffectiveFrom: null };

export interface ParsedRateRow {
  serviceCode: string;
  serviceName: string;
  serviceNameHi: string | null;
  category: (typeof SERVICE_CATEGORIES)[number];
  departmentCode: string | null;
  unit: (typeof SERVICE_UNITS)[number] | null;
  sacCode: string | null;
  /** null = not given (new service: exempt; existing service: unchanged). */
  gstRateBp: number | null;
  tariffName: string;
  ratePaise: Paise;
  effectiveFrom: string;
}

const CATEGORY_ALIASES: Record<string, (typeof SERVICE_CATEGORIES)[number]> = {
  opd: 'consultation',
  opd_consultation: 'consultation',
  consult: 'consultation',
  consultation_fee: 'consultation',
  procedures: 'procedure',
  ultrasound: 'usg',
  sonography: 'usg',
  laboratory: 'lab',
  pathology: 'lab',
  investigation: 'lab',
  room: 'bed',
  ward: 'bed',
  bed_charges: 'bed',
  operation_theatre: 'ot',
  operation: 'ot',
  surgery: 'ot',
  visit: 'doctor_visit',
  consultant_visit: 'doctor_visit',
  miscellaneous: 'misc',
  other: 'misc',
  others: 'misc',
};

const UNIT_ALIASES: Record<string, (typeof SERVICE_UNITS)[number]> = {
  visit: 'per_visit',
  day: 'per_day',
  daily: 'per_day',
  hour: 'per_hour',
  hourly: 'per_hour',
  unit: 'per_unit',
  each: 'per_unit',
  piece: 'per_unit',
  nos: 'per_unit',
};

const slug = (s: string) =>
  cleanText(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Rupee text → paise. `₹ 1,200/-`, `Rs. 500`, `499.5`; more than two decimals is an error. */
export function parseRupeesCell(raw: string): Paise | null {
  const s = cleanText(raw)
    .replace(/^(?:₹|rs\.?|inr)\s*/i, '')
    .replace(/\s*(?:\/-|-\/|only)\s*$/i, '')
    .replace(/,/g, '')
    .trim();
  if (/^\d+(\.\d{1,2})?$/.test(s)) return rupeesToPaise(s);
  // Float noise from a spreadsheet formula (499.99999999999994): accept only if it is 2-dp ± 1e-6.
  if (/^\d+\.\d{3,}$/.test(s)) {
    const n = Number(s);
    const r = Math.round(n * 100);
    if (Math.abs(n * 100 - r) < 1e-4) return BigInt(r);
  }
  return null;
}

/** GST % text → basis points: `5`, `5%`, `12.5`, `exempt` / `nil` → 0. */
export function parseGstPercentCell(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/%$/, '').trim();
  if (['exempt', 'exempted', 'nil', 'zero'].includes(s)) return 0;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bp <= 10_000 ? bp : null;
}

export function validateRateRow(
  cells: Record<string, string>,
  opts: RateImportOptions,
  today: CalendarDate,
): RowResult<ParsedRateRow> {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const err = (field: string, code: string) => errors.push({ field, code });

  const code = cleanText(cells.service_code ?? '')
    .toUpperCase()
    .replace(/\s+/g, '-');
  if (!code) err('service_code', 'codeRequired');
  else if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(code)) err('service_code', 'codeInvalid');

  const name = cleanText(cells.service_name ?? '');
  if (!name) err('service_name', 'serviceNameRequired');
  else if (name.length < 2 || name.length > 120) err('service_name', 'serviceNameInvalid');
  const nameHi = cleanText(cells.service_name_hi ?? '');
  if (nameHi.length > 120) err('service_name_hi', 'serviceNameInvalid');

  const catKey = slug(cells.category ?? '');
  const category = (SERVICE_CATEGORIES as readonly string[]).includes(catKey)
    ? (catKey as (typeof SERVICE_CATEGORIES)[number])
    : (CATEGORY_ALIASES[catKey] ?? null);
  if (!category) err('category', cells.category ? 'categoryInvalid' : 'categoryRequired');

  let unit: ParsedRateRow['unit'] = null;
  if (cells.unit) {
    const u = slug(cells.unit).replace(/^per_/, '');
    unit = (SERVICE_UNITS as readonly string[]).includes(`per_${u}`)
      ? (`per_${u}` as (typeof SERVICE_UNITS)[number])
      : (UNIT_ALIASES[u] ?? null);
    if (!unit) err('unit', 'unitInvalid');
  }

  let sac: string | null = null;
  if (cells.sac_code) {
    const s = cells.sac_code.replace(/[\s.]/g, '');
    if (/^\d{4,8}$/.test(s)) sac = s;
    else err('sac_code', 'sacInvalid');
  }
  let gstRateBp: number | null = null;
  if (cells.gst_rate_percent) {
    gstRateBp = parseGstPercentCell(cells.gst_rate_percent);
    if (gstRateBp === null) err('gst_rate_percent', 'gstInvalid');
  }

  const tariff = cleanText(cells.tariff_name ?? '');
  if (!tariff) err('tariff_name', 'tariffRequired');
  if (cells.room_category) err('room_category', 'roomCategoryUnsupported');

  let ratePaise: Paise | null = null;
  if (!cells.rate_inr) err('rate_inr', 'rateRequired');
  else {
    ratePaise = parseRupeesCell(cells.rate_inr);
    if (ratePaise === null) err('rate_inr', 'rateInvalid');
  }

  let effectiveFrom: string | null = null;
  if (cells.effective_from) {
    const d = parseDateCell(cells.effective_from, today);
    if (!d) err('effective_from', 'dateInvalid');
    else effectiveFrom = toIsoDate(d);
  } else if (opts.defaultEffectiveFrom) {
    effectiveFrom = opts.defaultEffectiveFrom;
    warnings.push({ field: 'effective_from', code: 'dateDefaulted' });
  } else err('effective_from', 'dateRequired');
  if (effectiveFrom) {
    const d = parseIsoDate(effectiveFrom);
    if (d.year < 2000 || compareDates(d, { ...today, year: today.year + 1 }) > 0) {
      err('effective_from', 'dateOutOfRange');
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    value: {
      serviceCode: code,
      serviceName: name.replace(/\s+/g, ' '),
      serviceNameHi: nameHi || null,
      category: category!,
      departmentCode: cells.department_code ? cleanText(cells.department_code).toUpperCase() : null,
      unit,
      sacCode: sac,
      gstRateBp,
      tariffName: tariff,
      ratePaise: ratePaise!,
      effectiveFrom: effectiveFrom!,
    },
  };
}

// ---------------------------------------------------------------- error report

export interface ReportRow {
  sourceRow: number;
  raw: readonly Cell[];
  status: ImportRowStatus;
  issues: readonly RowIssue[];
}

/**
 * Rows the user must look at, as CSV cells: source row number, status, problems, then the
 * original columns unchanged, so the file can be corrected and uploaded again. `describe` turns an
 * issue into the user's language.
 */
export function buildErrorReport(
  headers: readonly string[],
  rows: readonly ReportRow[],
  labels: { row: string; status: string; problems: string; statuses: Record<string, string> },
  describe: (issue: RowIssue) => string,
): (string | number)[][] {
  const out: (string | number)[][] = [[labels.row, labels.status, labels.problems, ...headers]];
  for (const r of rows) {
    out.push([
      r.sourceRow,
      labels.statuses[r.status] ?? r.status,
      r.issues.map(describe).join('; '),
      ...headers.map((_, i) => r.raw[i] ?? ''),
    ]);
  }
  return out;
}
