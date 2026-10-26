/**
 * Excel / CSV import (MIG-01, docs/10 §9, docs/33 §9): stage an uploaded file, dry-run it, commit
 * in batches. Two importers share the flow: patients (from the old register) and the rate list.
 *
 *  - Upload stores every row as read in `import_row` and classifies it: `ok`, `error`,
 *    `duplicate`, `unchanged`. Nothing but staging rows is written.
 *  - A remap (different column mapping / options) re-classifies the same rows.
 *  - Commit runs `IMPORT_COMMIT_BATCH` rows per transaction, each row in its own savepoint, so a
 *    bad row is marked `failed` and the rest go on. One long transaction would hold the UHID
 *    series row and stall the reception counter (AGENTS.md rule 11). A commit can be stopped and
 *    resumed: rows already `committed` are never touched again.
 *  - Row validation is repeated from the stored raw cells at commit time (one source of truth:
 *    `@hmis/shared` import.ts), and patients go through the normal `registerPatient`, so the UHID
 *    series, locality learning, duplicate rule and audit trigger behave exactly as at the counter.
 */
import { createHash } from 'node:crypto';
import {
  dobWithinYears,
  IMPORT_COMMIT_BATCH,
  IMPORT_TARGETS,
  importOptionsSchema,
  istToday,
  joinName,
  mappedRow,
  nameSearchKeys,
  OLD_REG_NO_LABEL,
  OVERRIDABLE_DUPLICATE_CODES,
  resolveDob,
  toIsoDate,
  trigramSimilarity,
  validatePatientRow,
  validateRateRow,
  formatINR,
  type ImportKind,
  type ImportOptions,
  type ImportRowStatus,
  type ParsedPatientRow,
  type ParsedRateRow,
  type RowIssue,
} from '@hmis/shared';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  department,
  importBatch,
  importRow,
  patient,
  patientIdentifier,
  service,
  serviceRate,
  tariff,
} from '../schema';
import { currentAppUserId } from '../schema/columns';
import { readSpreadsheet } from './import-read';
import { MasterRefError, setServiceRate } from './masters';
import { duplicateSettings, findDuplicates, registerPatient } from './patients';
import { withTx, type Tx, type TxContext } from './tx';

export type ImportContext = TxContext & { facilityId: string };

export class ImportError extends Error {
  constructor(
    readonly key:
      | 'import.notFound'
      | 'import.notEditable'
      | 'import.mappingInvalid'
      | 'import.fileInvalid'
      | 'import.fileEmpty'
      | 'import.fileNoHeader'
      | 'import.fileTooBig',
  ) {
    super(key);
    this.name = 'ImportError';
  }
}

type StoredIssue = { field: string; code: string; level: 'error' | 'warning' };
type RowRecord = typeof importRow.$inferSelect;
type BatchRecord = typeof importBatch.$inferSelect;

interface Verdict {
  status: ImportRowStatus;
  issues: StoredIssue[];
  preview: Record<string, string>;
  duplicateOfId: string | null;
}

const asIssues = (list: readonly RowIssue[], level: StoredIssue['level']): StoredIssue[] =>
  list.map((i) => ({ ...i, level }));

const CHUNK = 500;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const parseOptions = (raw: unknown): ImportOptions => importOptionsSchema.parse(raw ?? {});

// ---------------------------------------------------------------- upload

export interface UploadInput {
  kind: ImportKind;
  fileName: string;
  bytes: Uint8Array;
  options?: unknown;
}

/** Reads the file, stores the rows and runs the first dry run. Returns the batch id. */
export async function createImportBatch(
  ctx: ImportContext,
  input: UploadInput,
  now: Date,
): Promise<string> {
  let sheet;
  try {
    sheet = await readSpreadsheet(input.kind, input.bytes, input.fileName);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    throw new ImportError(
      code === 'empty'
        ? 'import.fileEmpty'
        : code === 'noHeader'
          ? 'import.fileNoHeader'
          : code === 'tooManyRows'
            ? 'import.fileTooBig'
            : 'import.fileInvalid',
    );
  }
  const options = parseOptions(input.options);
  const id = uuidv7();
  await withTx(ctx, async (tx) => {
    await tx.insert(importBatch).values({
      id,
      facilityId: ctx.facilityId,
      kind: input.kind,
      fileName: input.fileName.slice(0, 200),
      fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
      headers: sheet.headers,
      mapping: sheet.mapping,
      options,
      totalRows: sheet.rows.length,
    });
    for (const part of chunks(
      sheet.rows.map((raw, i) => ({
        id: uuidv7(),
        facilityId: ctx.facilityId,
        batchId: id,
        seq: i + 1,
        sourceRow: sheet.sourceRows[i]!,
        raw,
      })),
      CHUNK,
    )) {
      await tx.insert(importRow).values(part);
    }
    await classifyBatch(tx, ctx.facilityId, id, now);
  });
  return id;
}

// ---------------------------------------------------------------- dry run

async function loadBatch(tx: Tx, facilityId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(importBatch)
    .where(and(eq(importBatch.id, id), eq(importBatch.facilityId, facilityId)));
  const [b] = await (lock ? q.for('update') : q);
  if (!b) throw new ImportError('import.notFound');
  return b;
}

async function countByStatus(tx: Tx, batchId: string): Promise<Record<string, number>> {
  const res = await tx.execute<{ status: string; n: number }>(
    sql`select status, count(*)::int as n from import_row where batch_id = ${batchId} group by status`,
  );
  return Object.fromEntries(res.rows.map((r) => [r.status, r.n]));
}

async function writeVerdicts(tx: Tx, rows: RowRecord[], verdicts: Verdict[]) {
  for (const part of chunks(
    rows.map((r, i) => ({
      id: r.id,
      status: verdicts[i]!.status,
      issues: verdicts[i]!.issues,
      preview: verdicts[i]!.preview,
      duplicate_of_id: verdicts[i]!.duplicateOfId,
    })),
    CHUNK,
  )) {
    await tx.execute(sql`
      update import_row r
      set status = v.status, issues = v.issues, preview = v.preview,
          duplicate_of_id = v.duplicate_of_id, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(part)}::jsonb)
        as v(id uuid, status text, issues jsonb, preview jsonb, duplicate_of_id uuid)
      where r.id = v.id`);
  }
}

/** (Re-)classifies every row of a batch still in the dry-run stage and refreshes the counts. */
async function classifyBatch(tx: Tx, facilityId: string, batchId: string, now: Date) {
  const batch = await loadBatch(tx, facilityId, batchId);
  if (batch.stage !== 'dry_run' || batch.status !== 'active') throw new ImportError('import.notEditable');
  const rows = await tx
    .select()
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .orderBy(asc(importRow.seq));
  const options = parseOptions(batch.options);
  const today = istToday(now);
  const verdicts =
    batch.kind === 'patients'
      ? await classifyPatients(tx, facilityId, rows, batch.mapping, options, today)
      : await classifyRates(tx, facilityId, rows, batch.mapping, options, today);
  await writeVerdicts(tx, rows, verdicts);
  await tx
    .update(importBatch)
    .set({ counts: await countByStatus(tx, batchId), totalRows: rows.length })
    .where(eq(importBatch.id, batchId));
}

const patientPreview = (p: ParsedPatientRow, today: ReturnType<typeof istToday>) => {
  const dob = resolveDob(p.input, today);
  return {
    name: joinName(p.input),
    sex: p.input.sex,
    mobile: p.input.mobile ?? '',
    dob: dob ? `${dob.dob}${dob.estimated ? ' ~' : ''}` : '',
    ...(p.oldUhid ? { oldUhid: p.oldUhid } : {}),
  };
};

async function classifyPatients(
  tx: Tx,
  facilityId: string,
  rows: RowRecord[],
  mapping: (string | null)[],
  options: ImportOptions,
  today: ReturnType<typeof istToday>,
): Promise<Verdict[]> {
  const cfg = await duplicateSettings(tx, facilityId);
  const minSim = cfg['registration.duplicateMinSimilarityPct'] / 100;
  const tolerance = cfg['registration.duplicateAgeToleranceYears'];

  // Numbers from the old register that earlier imports already brought in.
  const parsed = rows.map((r) =>
    validatePatientRow(mappedRow(r.raw, mapping), { allowMissingMobile: options.allowMissingMobile }, today),
  );
  const oldNos = [
    ...new Set(parsed.flatMap((p) => (p.ok && p.value.oldUhid ? [p.value.oldUhid] : []))),
  ];
  const imported = new Map<string, string>();
  for (const part of chunks(oldNos, CHUNK)) {
    const found = await tx
      .select({ value: patientIdentifier.value, patientId: patientIdentifier.patientId })
      .from(patientIdentifier)
      .where(
        and(
          eq(patientIdentifier.facilityId, facilityId),
          eq(patientIdentifier.type, 'other'),
          eq(patientIdentifier.label, OLD_REG_NO_LABEL),
          eq(patientIdentifier.status, 'active'),
          inArray(patientIdentifier.value, part),
        ),
      );
    for (const f of found) imported.set(f.value.toLowerCase(), f.patientId);
  }

  const seenOldNo = new Set<string>();
  const earlier = new Map<string, { phonetic: string; dob: string }[]>();
  const out: Verdict[] = [];
  for (const res of parsed) {
    if (!res.ok) {
      out.push({
        status: 'error',
        issues: [...asIssues(res.errors, 'error'), ...asIssues(res.warnings, 'warning')],
        preview: {},
        duplicateOfId: null,
      });
      continue;
    }
    const p = res.value;
    const issues = asIssues(res.warnings, 'warning');
    const preview: Record<string, string> = patientPreview(p, today);
    const dup = (code: string, of: string | null = null): Verdict => ({
      status: 'duplicate',
      issues: [...issues, { field: 'row', code, level: 'warning' }],
      preview,
      duplicateOfId: of,
    });

    const key = p.oldUhid?.toLowerCase();
    if (key && imported.has(key)) {
      out.push(dup('alreadyImported', imported.get(key)!));
      continue;
    }
    if (key && seenOldNo.has(key)) {
      out.push(dup('oldRegNoInFile'));
      continue;
    }
    if (key) seenOldNo.add(key);

    const dob = resolveDob(p.input, today)!.dob;
    const phonetic = nameSearchKeys(joinName(p.input)).phonetic;
    let verdict: Verdict | null = null;
    if (p.input.mobile) {
      const mine = earlier.get(p.input.mobile) ?? [];
      if (
        mine.some((e) => trigramSimilarity(e.phonetic, phonetic) >= minSim && dobWithinYears(e.dob, dob, tolerance))
      ) {
        verdict = dup('duplicateInFile');
      } else {
        const [match] = await findDuplicates(
          tx,
          facilityId,
          { ...p.input, mobile: p.input.mobile, dob },
          1,
          cfg,
        );
        if (match) {
          preview.matchUhid = match.uhid;
          preview.matchName = match.fullName;
          verdict = dup('duplicateExisting', match.id);
        }
      }
      earlier.set(p.input.mobile, [...mine, { phonetic, dob }]);
    }
    out.push(verdict ?? { status: 'ok', issues, preview, duplicateOfId: null });
  }
  return out;
}

interface RateRefs {
  tariffs: Map<string, string>;
  departments: Map<string, string>;
  services: Map<string, typeof service.$inferSelect>;
}

const nameKey = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

async function loadRateRefs(tx: Tx, facilityId: string, codes: string[]): Promise<RateRefs> {
  const tariffs = await tx
    .select({ id: tariff.id, name: tariff.name })
    .from(tariff)
    .where(and(eq(tariff.facilityId, facilityId), eq(tariff.status, 'active')));
  const departments = await tx
    .select({ id: department.id, code: department.code })
    .from(department)
    .where(and(eq(department.facilityId, facilityId), eq(department.status, 'active')));
  const services = new Map<string, typeof service.$inferSelect>();
  for (const part of chunks(codes, CHUNK)) {
    const found = await tx
      .select()
      .from(service)
      .where(
        and(eq(service.facilityId, facilityId), inArray(sql`lower(${service.code})`, part.map((c) => c.toLowerCase()))),
      );
    for (const s of found) services.set(s.code.toLowerCase(), s);
  }
  return {
    tariffs: new Map(tariffs.map((t) => [nameKey(t.name), t.id])),
    departments: new Map(departments.map((d) => [d.code.toLowerCase(), d.id])),
    services,
  };
}

/** Which service fields the file would change (names of columns, for the preview). */
function serviceChanges(row: ParsedRateRow, cur: typeof service.$inferSelect, deptId: string | null) {
  const changed: string[] = [];
  if (row.serviceName !== cur.name) changed.push('service_name');
  if (row.serviceNameHi !== null && row.serviceNameHi !== cur.nameHi) changed.push('service_name_hi');
  if (row.category !== cur.category) changed.push('category');
  if (deptId !== null && deptId !== cur.departmentId) changed.push('department_code');
  if (row.unit !== null && row.unit !== cur.unit) changed.push('unit');
  if (row.sacCode !== null && row.sacCode !== cur.sacCode) changed.push('sac_code');
  if (row.gstRateBp !== null && row.gstRateBp !== cur.defaultGstRateBp) changed.push('gst_rate_percent');
  return changed;
}

const rupees = (p: bigint) => formatINR(p);

async function classifyRates(
  tx: Tx,
  facilityId: string,
  rows: RowRecord[],
  mapping: (string | null)[],
  options: ImportOptions,
  today: ReturnType<typeof istToday>,
): Promise<Verdict[]> {
  const parsed = rows.map((r) =>
    validateRateRow(mappedRow(r.raw, mapping), { defaultEffectiveFrom: options.defaultEffectiveFrom }, today),
  );
  const codes = [...new Set(parsed.flatMap((p) => (p.ok ? [p.value.serviceCode] : [])))];
  const refs = await loadRateRefs(tx, facilityId, codes);
  const todayIso = toIsoDate(today);

  const firstOfCode = new Map<string, ParsedRateRow>();
  const seenKey = new Map<string, bigint>();
  const out: Verdict[] = [];
  for (const res of parsed) {
    if (!res.ok) {
      out.push({
        status: 'error',
        issues: [...asIssues(res.errors, 'error'), ...asIssues(res.warnings, 'warning')],
        preview: {},
        duplicateOfId: null,
      });
      continue;
    }
    const r = res.value;
    const errors: RowIssue[] = [];
    const issues = asIssues(res.warnings, 'warning');
    const preview: Record<string, string> = {
      code: r.serviceCode,
      name: r.serviceName,
      tariff: r.tariffName,
      from: r.effectiveFrom,
      rate: rupees(r.ratePaise),
    };

    const tariffId = refs.tariffs.get(nameKey(r.tariffName));
    if (!tariffId) errors.push({ field: 'tariff_name', code: 'tariffNotFound' });
    const deptId = r.departmentCode ? (refs.departments.get(r.departmentCode.toLowerCase()) ?? null) : null;
    if (r.departmentCode && !deptId) errors.push({ field: 'department_code', code: 'departmentNotFound' });

    // The first row of a code defines the service; later rows of the same code must agree.
    const first = firstOfCode.get(r.serviceCode);
    if (!first) firstOfCode.set(r.serviceCode, r);
    else if (
      first.serviceName !== r.serviceName ||
      first.category !== r.category ||
      (r.unit !== null && first.unit !== null && first.unit !== r.unit) ||
      (r.gstRateBp !== null && first.gstRateBp !== null && first.gstRateBp !== r.gstRateBp)
    ) {
      errors.push({ field: 'service_code', code: 'serviceConflictInFile' });
    }

    const existing = refs.services.get(r.serviceCode.toLowerCase());
    if (existing && existing.status !== 'active') errors.push({ field: 'service_code', code: 'serviceCancelled' });
    let changes: string[] = [];
    if (existing && existing.status === 'active') changes = serviceChanges(r, existing, deptId);
    preview.service = !existing ? 'new' : changes.length ? `update: ${changes.join(', ')}` : 'same';

    const dupKey = `${r.serviceCode}|${nameKey(r.tariffName)}|${r.effectiveFrom}`;
    const prior = seenKey.get(dupKey);
    if (prior !== undefined) {
      if (prior !== r.ratePaise) errors.push({ field: 'rate_inr', code: 'rateConflictInFile' });
    } else seenKey.set(dupKey, r.ratePaise);

    if (errors.length) {
      out.push({ status: 'error', issues: [...asIssues(errors, 'error'), ...issues], preview, duplicateOfId: null });
      continue;
    }
    if (prior !== undefined) {
      out.push({
        status: 'duplicate',
        issues: [...issues, { field: 'row', code: 'duplicateInFile', level: 'warning' }],
        preview,
        duplicateOfId: null,
      });
      continue;
    }

    // What the rate is today (on the effective date) and whether this exact row is already there.
    let unchanged = false;
    if (existing && tariffId) {
      const [same] = await tx
        .select({ ratePaise: serviceRate.ratePaise })
        .from(serviceRate)
        .where(
          and(
            eq(serviceRate.facilityId, facilityId),
            eq(serviceRate.serviceId, existing.id),
            eq(serviceRate.tariffId, tariffId),
            sql`${serviceRate.roomCategoryId} is null`,
            eq(serviceRate.effectiveFrom, r.effectiveFrom),
            eq(serviceRate.status, 'active'),
          ),
        );
      unchanged = same?.ratePaise === r.ratePaise && changes.length === 0;
      const [current] = await tx
        .select({ ratePaise: serviceRate.ratePaise })
        .from(serviceRate)
        .where(
          and(
            eq(serviceRate.facilityId, facilityId),
            eq(serviceRate.serviceId, existing.id),
            eq(serviceRate.tariffId, tariffId),
            sql`${serviceRate.roomCategoryId} is null`,
            sql`${serviceRate.effectiveFrom} <= ${r.effectiveFrom <= todayIso ? r.effectiveFrom : todayIso}`,
            eq(serviceRate.status, 'active'),
          ),
        )
        .orderBy(sql`${serviceRate.effectiveFrom} desc`)
        .limit(1);
      if (current) {
        preview.oldRate = rupees(current.ratePaise);
        // A rate that halves or more than-1.5x is probably a typo (extra zero, missing digit).
        const old = current.ratePaise;
        if (old > 0n && (r.ratePaise * 2n < old || r.ratePaise * 2n > old * 3n)) {
          issues.push({ field: 'rate_inr', code: 'rateChangeLarge', level: 'warning' });
        }
      }
    }
    out.push({ status: unchanged ? 'unchanged' : 'ok', issues, preview, duplicateOfId: null });
  }
  return out;
}

// ---------------------------------------------------------------- remap

export interface RemapInput {
  batchId: string;
  mapping?: (string | null)[];
  options?: unknown;
}

/** Changes the column mapping and / or options of a batch not yet committing, and re-checks it. */
export async function remapImportBatch(ctx: ImportContext, input: RemapInput, now: Date) {
  return withTx(ctx, async (tx) => {
    const batch = await loadBatch(tx, ctx.facilityId, input.batchId, true);
    if (batch.stage !== 'dry_run' || batch.status !== 'active') throw new ImportError('import.notEditable');
    const set: Partial<typeof importBatch.$inferInsert> = {};
    if (input.mapping) {
      const targets = IMPORT_TARGETS[batch.kind as ImportKind] as readonly string[];
      const used = new Set<string>();
      if (input.mapping.length !== batch.headers.length) throw new ImportError('import.mappingInvalid');
      for (const t of input.mapping) {
        if (t === null) continue;
        if (!targets.includes(t) || used.has(t)) throw new ImportError('import.mappingInvalid');
        used.add(t);
      }
      set.mapping = input.mapping;
    }
    if (input.options !== undefined) set.options = parseOptions({ ...batch.options, ...(input.options as object) });
    if (Object.keys(set).length) await tx.update(importBatch).set(set).where(eq(importBatch.id, batch.id));
    await classifyBatch(tx, ctx.facilityId, batch.id, now);
    return loadBatch(tx, ctx.facilityId, batch.id);
  });
}

// ---------------------------------------------------------------- commit

export interface CommitProgress {
  processed: number;
  remaining: number;
  done: boolean;
  counts: Record<string, number>;
}

const OVERRIDABLE = sql.join(
  OVERRIDABLE_DUPLICATE_CODES.map((c) => sql`${importRow.issues} @> ${JSON.stringify([{ code: c }])}::jsonb`),
  sql` or `,
);

/** Rows a commit would still write: `ok`, plus overridable duplicates when the user chose so. */
const pendingWhere = (batchId: string, options: ImportOptions) =>
  and(
    eq(importRow.batchId, batchId),
    options.duplicates === 'import'
      ? sql`(${importRow.status} = 'ok' or (${importRow.status} = 'duplicate' and (${OVERRIDABLE})))`
      : eq(importRow.status, 'ok'),
  );

interface Outcome {
  status: ImportRowStatus;
  issues?: StoredIssue[];
  resultId?: string | null;
  duplicateOfId?: string | null;
}

async function commitPatientRow(
  tx: Tx,
  facilityId: string,
  row: RowRecord,
  batch: BatchRecord,
  options: ImportOptions,
  now: Date,
): Promise<Outcome> {
  const res = validatePatientRow(
    mappedRow(row.raw, batch.mapping),
    { allowMissingMobile: options.allowMissingMobile },
    istToday(now),
  );
  if (!res.ok) return { status: 'error', issues: asIssues(res.errors, 'error') };
  const asDuplicate = row.status === 'duplicate';
  const out = await registerPatient(
    tx,
    facilityId,
    asDuplicate
      ? { ...res.value.input, duplicateOverride: { reason: 'Imported from file (MIG-01); possible duplicate' } }
      : res.value.input,
    now,
  );
  if (out.status === 'duplicates') {
    // Someone registered a look-alike after the dry run.
    return {
      status: 'duplicate',
      issues: [...row.issues.filter((i) => i.level === 'warning'), { field: 'row', code: 'duplicateExisting', level: 'warning' }],
      duplicateOfId: out.matches[0]!.id,
    };
  }
  if (res.value.oldUhid) {
    await tx.insert(patientIdentifier).values({
      facilityId,
      patientId: out.id,
      type: 'other',
      label: OLD_REG_NO_LABEL,
      value: res.value.oldUhid,
    });
  }
  return { status: 'committed', resultId: out.id, issues: row.issues };
}

async function commitRateRow(
  tx: Tx,
  facilityId: string,
  row: RowRecord,
  batch: BatchRecord,
  options: ImportOptions,
  now: Date,
): Promise<Outcome> {
  const res = validateRateRow(
    mappedRow(row.raw, batch.mapping),
    { defaultEffectiveFrom: options.defaultEffectiveFrom },
    istToday(now),
  );
  if (!res.ok) return { status: 'error', issues: asIssues(res.errors, 'error') };
  const r = res.value;
  const refs = await loadRateRefs(tx, facilityId, [r.serviceCode]);
  const tariffId = refs.tariffs.get(nameKey(r.tariffName));
  const deptId = r.departmentCode ? (refs.departments.get(r.departmentCode.toLowerCase()) ?? null) : null;
  const fail = (field: string, code: string): Outcome => ({ status: 'failed', issues: [{ field, code, level: 'error' }] });
  if (!tariffId) return fail('tariff_name', 'tariffNotFound');
  if (r.departmentCode && !deptId) return fail('department_code', 'departmentNotFound');

  let serviceId: string;
  let serviceChanged = false;
  const existing = refs.services.get(r.serviceCode.toLowerCase());
  if (existing) {
    if (existing.status !== 'active') return fail('service_code', 'serviceCancelled');
    serviceId = existing.id;
    const changes = serviceChanges(r, existing, deptId);
    if (changes.length) {
      serviceChanged = true;
      await tx
        .update(service)
        .set({
          name: r.serviceName,
          category: r.category,
          ...(r.serviceNameHi !== null ? { nameHi: r.serviceNameHi } : {}),
          ...(deptId !== null ? { departmentId: deptId } : {}),
          ...(r.unit !== null ? { unit: r.unit } : {}),
          ...(r.sacCode !== null ? { sacCode: r.sacCode } : {}),
          ...(r.gstRateBp !== null ? { defaultGstRateBp: r.gstRateBp, isExempt: r.gstRateBp === 0 } : {}),
        })
        .where(eq(service.id, existing.id));
    }
  } else {
    serviceId = uuidv7();
    serviceChanged = true;
    await tx.insert(service).values({
      id: serviceId,
      facilityId,
      code: r.serviceCode,
      name: r.serviceName,
      nameHi: r.serviceNameHi,
      category: r.category,
      departmentId: deptId,
      sacCode: r.sacCode,
      defaultGstRateBp: r.gstRateBp ?? 0,
      isExempt: (r.gstRateBp ?? 0) === 0,
      unit: r.unit ?? 'per_visit',
    });
  }
  try {
    const rate = await setServiceRate(tx, {
      facilityId,
      serviceId,
      tariffId,
      ratePaise: r.ratePaise,
      effectiveFrom: r.effectiveFrom,
    });
    if (!rate.changed && !serviceChanged) return { status: 'unchanged', resultId: rate.id };
    return { status: 'committed', resultId: rate.id, issues: row.issues };
  } catch (err) {
    if (err instanceof MasterRefError) return fail('tariff_name', 'tariffNotFound');
    throw err;
  }
}

/**
 * Commits the next `limit` pending rows of a batch in one transaction and reports progress.
 * Call until `done`. Safe to call again after a crash or from two screens: the batch row is locked
 * and finished rows are never picked up twice.
 */
export async function commitImportStep(
  ctx: ImportContext,
  batchId: string,
  now: Date,
  limit = IMPORT_COMMIT_BATCH,
): Promise<CommitProgress> {
  return withTx(ctx, async (tx) => {
    const batch = await loadBatch(tx, ctx.facilityId, batchId, true);
    if (batch.status !== 'active' || (batch.stage !== 'dry_run' && batch.stage !== 'committing')) {
      throw new ImportError('import.notEditable');
    }
    const options = parseOptions(batch.options);
    const rows = await tx
      .select()
      .from(importRow)
      .where(pendingWhere(batchId, options))
      .orderBy(asc(importRow.seq))
      .limit(Math.max(1, limit));

    for (const row of rows) {
      let outcome: Outcome;
      try {
        // Own savepoint: a failing row rolls back its own writes only.
        outcome = await tx.transaction((sp) =>
          batch.kind === 'patients'
            ? commitPatientRow(sp, ctx.facilityId, row, batch, options, now)
            : commitRateRow(sp, ctx.facilityId, row, batch, options, now),
        );
      } catch {
        // No SQL text or patient data from the driver goes to the screen or the logs.
        outcome = { status: 'failed', issues: [{ field: 'row', code: 'saveFailed', level: 'error' }] };
      }
      await tx
        .update(importRow)
        .set({
          status: outcome.status,
          issues: outcome.issues ?? row.issues,
          resultId: outcome.resultId ?? null,
          ...(outcome.duplicateOfId !== undefined ? { duplicateOfId: outcome.duplicateOfId } : {}),
        })
        .where(eq(importRow.id, row.id));
    }

    const [{ n: remaining } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(importRow)
      .where(pendingWhere(batchId, options));
    const counts = await countByStatus(tx, batchId);
    await tx
      .update(importBatch)
      .set({ counts, stage: remaining === 0 ? 'committed' : 'committing' })
      .where(eq(importBatch.id, batchId));
    return { processed: rows.length, remaining, done: remaining === 0, counts };
  });
}

/** Runs every step (tests, scripts). The screen calls `commitImportStep` itself for progress. */
export async function commitImportBatch(
  ctx: ImportContext,
  batchId: string,
  now: Date,
  limit = IMPORT_COMMIT_BATCH,
): Promise<CommitProgress> {
  for (;;) {
    const p = await commitImportStep(ctx, batchId, now, limit);
    if (p.done) return p;
  }
}

// ---------------------------------------------------------------- cancel and read

export async function cancelImportBatch(ctx: ImportContext, batchId: string, reason: string) {
  await withTx(ctx, async (tx) => {
    const batch = await loadBatch(tx, ctx.facilityId, batchId, true);
    if (batch.stage !== 'dry_run' || batch.status !== 'active') throw new ImportError('import.notEditable');
    await tx
      .update(importBatch)
      .set({
        stage: 'cancelled',
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: sql`now()`,
        cancelledBy: currentAppUserId,
      })
      .where(eq(importBatch.id, batchId));
  });
}

export async function getImportBatch(tx: Tx, facilityId: string, batchId: string) {
  return loadBatch(tx, facilityId, batchId);
}

export async function listImportBatches(tx: Tx, facilityId: string, limit = 20) {
  return tx
    .select({
      id: importBatch.id,
      kind: importBatch.kind,
      fileName: importBatch.fileName,
      stage: importBatch.stage,
      totalRows: importBatch.totalRows,
      counts: importBatch.counts,
      createdAt: importBatch.createdAt,
    })
    .from(importBatch)
    .where(eq(importBatch.facilityId, facilityId))
    .orderBy(sql`${importBatch.createdAt} desc`, sql`${importBatch.id} desc`)
    .limit(limit);
}

export async function listImportRows(
  tx: Tx,
  facilityId: string,
  batchId: string,
  opts: { statuses?: readonly ImportRowStatus[]; afterSeq?: number; limit?: number } = {},
) {
  return tx
    .select({
      id: importRow.id,
      seq: importRow.seq,
      sourceRow: importRow.sourceRow,
      raw: importRow.raw,
      status: importRow.status,
      issues: importRow.issues,
      preview: importRow.preview,
    })
    .from(importRow)
    .where(
      and(
        eq(importRow.facilityId, facilityId),
        eq(importRow.batchId, batchId),
        opts.statuses?.length ? inArray(importRow.status, [...opts.statuses]) : undefined,
        opts.afterSeq ? gt(importRow.seq, opts.afterSeq) : undefined,
      ),
    )
    .orderBy(asc(importRow.seq))
    .limit(Math.min(opts.limit ?? 100, 10_000));
}
