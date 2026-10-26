import { rupeesToPaise } from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, importBatch, patient, patientIdentifier, service, serviceRate } from '../schema';
import { seedMasters } from '../seed/masters';
import { TEMPLATE_DIR } from '../seed/templates/generate';
import { seedFacility, setupPlatformDb, type PlatformTestDb } from '../testing/platform';
import {
  cancelImportBatch,
  commitImportBatch,
  commitImportStep,
  createImportBatch,
  getImportBatch,
  ImportError,
  listImportRows,
  remapImportBatch,
  type ImportContext,
} from './import';
import { getRate } from './masters';
import { withTx } from './tx';

let t: PlatformTestDb;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'), 25);
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date('2026-10-26T05:00:00Z'); // 26-Oct-2026 IST

async function facilityWithMasters() {
  const f = await seedFacility(t.owner);
  await withTx({ db: t.app, userId: f.userId, facilityId: f.facilityId }, (tx) =>
    seedMasters(tx, f.facilityId, NOW),
  );
  const ctx: ImportContext = { db: t.app, userId: f.userId, facilityId: f.facilityId };
  return { f, ctx };
}

type Cell = string | number | Date | null;
async function xlsx(rows: Cell[][], sheetName = 'Sheet1'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
const csvBytes = (text: string) => new TextEncoder().encode(text);

const statuses = async (ctx: ImportContext, batchId: string) =>
  withTx(ctx, async (tx) => {
    const rows = await listImportRows(tx, ctx.facilityId, batchId, { limit: 1000 });
    return rows.map((r) => r.status);
  });
const rowsOf = (ctx: ImportContext, batchId: string) =>
  withTx(ctx, (tx) => listImportRows(tx, ctx.facilityId, batchId, { limit: 1000 }));
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

/** A patient register as a clinic really has it: title rows, blank row, odd headers. */
const messyRegister = (): Cell[][] => [
  ['SHREE HOSPITAL — OLD OPD REGISTER (2019-2026)', null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ['Reg No', 'Patient Name', 'Age', 'D.O.B', 'Gender', 'Mob. No', 'W/o', 'Village'],
  [
    'OLD-1',
    'smt. sunita DEVI verma',
    '28 yrs',
    null,
    'Female',
    '98765 43210',
    'W/o ramesh verma',
    'rampur',
  ], // 4
  ['OLD-2', 'Sunitha Devi Verma', '29', null, 'F', '9876543210', 'Ramesh', 'Rampur'], // 5: same woman, in file
  ['OLD-3', 'Geeta', '30', null, 'F', '12345', '', ''], // 6: bad mobile
  [
    'OLD-4',
    'Kavita Singh',
    null,
    new Date(Date.UTC(1990, 2, 14)),
    'महिला',
    9123456780,
    'D/o Mohan Singh',
    '',
  ], // 7: Date cell, numeric mobile
  ['OLD-5', 'Meena', '35', null, '', '9811111111', '', ''], // 8: no sex
  [null, null, null, null, null, null, null, null], // 9: blank
  ['OLD-1', 'Pooja Rani', '22', null, 'F', '9822222222', '', ''], // 10: reg no reused
  ['OLD-6', 'Rekha Gupta', '31', null, 'F', '9833333333', '', 'Mishrikh'], // 11: matches existing patient (when registered)
  ['OLD-7', 'Anita', '27', null, 'F', '+91-98444-44444 / 9855555555', '', ''], // 12: two numbers
];

describe('patient import (MIG-01)', () => {
  it('dry-runs a messy register with per-row verdicts and duplicate detection', async () => {
    const { f, ctx } = await facilityWithMasters();
    // Rekha Gupta is already registered at the counter.
    const { registerPatient } = await import('./patients');
    const { createPatientSchema } = await import('@hmis/shared');
    await withTx(ctx, (tx) =>
      registerPatient(
        tx,
        f.facilityId,
        createPatientSchema.parse({
          firstName: 'Rekha',
          lastName: 'Gupta',
          sex: 'F',
          age: '31',
          mobile: '9833333333',
        }),
        NOW,
      ),
    );

    const id = await createImportBatch(
      ctx,
      { kind: 'patients', fileName: 'old-register.xlsx', bytes: await xlsx(messyRegister()) },
      NOW,
    );
    const rows = await rowsOf(ctx, id);

    expect(rows.map((r) => [r.sourceRow, r.status])).toEqual([
      [4, 'ok'],
      [5, 'duplicate'],
      [6, 'error'],
      [7, 'ok'],
      [8, 'error'],
      [10, 'duplicate'],
      [11, 'duplicate'],
      [12, 'ok'],
    ]);
    expect(codes(rows[1]!)).toContain('duplicateInFile');
    expect(codes(rows[2]!)).toEqual(['mobileInvalid']);
    expect(codes(rows[4]!)).toEqual(['sexRequired']);
    expect(codes(rows[5]!)).toContain('oldRegNoInFile');
    expect(codes(rows[6]!)).toContain('duplicateExisting');
    expect(rows[0]!.preview).toMatchObject({ name: 'Sunita Devi Verma', mobile: '9876543210' });
    expect(rows[3]!.preview.dob).toBe('1990-03-14');

    const batch = await withTx(ctx, (tx) => getImportBatch(tx, f.facilityId, id));
    expect(batch).toMatchObject({ stage: 'dry_run', totalRows: 8 });
    expect(batch.counts).toEqual({ ok: 3, error: 2, duplicate: 3 });
    // Nothing but staging rows was written.
    const n = await t.app
      .select({ n: sql<number>`count(*)::int` })
      .from(patient)
      .where(eq(patient.facilityId, f.facilityId));
    expect(n[0]!.n).toBe(1);
  });

  it('commits the ok rows in batches, with old reg no, learned locality and audit', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      { kind: 'patients', fileName: 'old-register.xlsx', bytes: await xlsx(messyRegister()) },
      NOW,
    );

    const first = await commitImportStep(ctx, id, NOW, 2);
    expect(first).toMatchObject({ processed: 2, remaining: 2, done: false });
    expect((await withTx(ctx, (tx) => getImportBatch(tx, f.facilityId, id))).stage).toBe(
      'committing',
    );
    const rest = await commitImportBatch(ctx, id, NOW, 2);
    expect(rest).toMatchObject({ remaining: 0, done: true });

    const batch = await withTx(ctx, (tx) => getImportBatch(tx, f.facilityId, id));
    expect(batch.stage).toBe('committed');
    expect(batch.counts).toEqual({ committed: 4, error: 2, duplicate: 2 });

    const people = await t.app
      .select()
      .from(patient)
      .where(eq(patient.facilityId, f.facilityId))
      .orderBy(patient.uhid);
    expect(people.map((p) => [p.fullName, p.mobile, p.altMobile, p.uhid])).toEqual([
      ['Sunita Devi Verma', '9876543210', null, 'UH-000001'],
      ['Kavita Singh', '9123456780', null, 'UH-000002'],
      ['Rekha Gupta', '9833333333', null, 'UH-000003'],
      ['Anita', '9844444444', '9855555555', 'UH-000004'],
    ]);
    expect(people[0]).toMatchObject({
      guardianName: 'Ramesh Verma',
      guardianRelation: 'husband',
      dobIsEstimated: true,
      district: null,
    });
    expect(people[1]).toMatchObject({
      dob: '1990-03-14',
      dobIsEstimated: false,
      guardianRelation: 'father',
    });

    const ids = await t.app
      .select()
      .from(patientIdentifier)
      .where(eq(patientIdentifier.facilityId, f.facilityId));
    expect(ids.map((i) => [i.type, i.label, i.value]).sort()).toEqual([
      ['other', 'Old reg no', 'OLD-1'],
      ['other', 'Old reg no', 'OLD-4'],
      ['other', 'Old reg no', 'OLD-6'],
      ['other', 'Old reg no', 'OLD-7'],
    ]);

    // Audit: batch and every created row carry the actor (AGENTS.md rule 5).
    const audit = await t.owner
      .select({ table: auditLog.tableName, by: auditLog.changedBy })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.facilityId, f.facilityId),
          sql`${auditLog.tableName} in ('import_batch', 'patient', 'patient_identifier')`,
        ),
      );
    expect(audit.filter((a) => a.table === 'patient')).toHaveLength(4);
    expect(audit.filter((a) => a.table === 'patient_identifier')).toHaveLength(4);
    expect(audit.some((a) => a.table === 'import_batch')).toBe(true);
    expect(audit.every((a) => a.by === f.userId)).toBe(true);
  });

  it('re-uploading the same file brings nothing in twice', async () => {
    const { f, ctx } = await facilityWithMasters();
    const bytes = await xlsx(messyRegister());
    const a = await createImportBatch(ctx, { kind: 'patients', fileName: 'r.xlsx', bytes }, NOW);
    await commitImportBatch(ctx, a, NOW);

    const b = await createImportBatch(ctx, { kind: 'patients', fileName: 'r.xlsx', bytes }, NOW);
    const rows = await rowsOf(ctx, b);
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(0);
    expect(
      rows.filter((r) => codes(r).includes('alreadyImported')).map((r) => r.sourceRow),
    ).toEqual([4, 7, 10, 11, 12]);

    // Even "import duplicates" must not re-create what an earlier import already brought in.
    await withTx(ctx, (tx) =>
      tx
        .update(importBatch)
        .set({ options: { duplicates: 'import' } })
        .where(eq(importBatch.id, b)),
    );
    await commitImportBatch(ctx, b, NOW);
    const total = await t.app
      .select({ n: sql<number>`count(*)::int` })
      .from(patient)
      .where(eq(patient.facilityId, f.facilityId));
    // 4 from the first run + row 5 (OLD-2: the same woman as OLD-1, a look-alike the user chose to
    // import). Rows 4, 7, 10, 11, 12 carry old reg nos already imported and never come in again.
    expect(total[0]!.n).toBe(5);
  });

  it('imports look-alikes only when asked, recording the override reason', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      {
        kind: 'patients',
        fileName: 'r.xlsx',
        bytes: await xlsx(messyRegister()),
        options: { duplicates: 'import' },
      },
      NOW,
    );
    await commitImportBatch(ctx, id, NOW);
    const people = await t.app.select().from(patient).where(eq(patient.facilityId, f.facilityId));
    // ok rows (4) + row 5, an in-file look-alike; row 10 reuses a reg no and stays out.
    expect(people.map((p) => p.fullName).sort()).toEqual(
      ['Anita', 'Kavita Singh', 'Rekha Gupta', 'Sunita Devi Verma', 'Sunitha Devi Verma'].sort(),
    );
    expect(
      people.find((p) => p.fullName === 'Sunitha Devi Verma')?.duplicateOverrideReason,
    ).toMatch(/MIG-01/);
  });

  it('catches a look-alike registered between the dry run and the commit', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      {
        kind: 'patients',
        fileName: 'r.csv',
        bytes: csvBytes('Name,Age,Sex,Mobile\nGeeta Rani,30,F,9810000001\n'),
      },
      NOW,
    );
    expect(await statuses(ctx, id)).toEqual(['ok']);
    const { registerPatient } = await import('./patients');
    const { createPatientSchema } = await import('@hmis/shared');
    await withTx(ctx, (tx) =>
      registerPatient(
        tx,
        f.facilityId,
        createPatientSchema.parse({
          firstName: 'Geeta',
          lastName: 'Rani',
          sex: 'F',
          age: '30',
          mobile: '9810000001',
        }),
        NOW,
      ),
    );
    await commitImportBatch(ctx, id, NOW);
    const [row] = await rowsOf(ctx, id);
    expect(row!.status).toBe('duplicate');
    expect(codes(row!)).toContain('duplicateExisting');
  });

  it('reads a semicolon CSV saved from Excel in Windows-1252 and lets the user remap a column', async () => {
    const { f, ctx } = await facilityWithMasters();
    // "Contact Person Phone" is not a known header: the wizard maps it to mobile by hand.
    const text =
      'First name;Sex;Age;Contact Person Phone;Village\r\nR\xe9ka;F;31;9877700001;M\xfcnshi Khera\r\n';
    const bytes = Uint8Array.from(Buffer.from(text, 'latin1'));
    const id = await createImportBatch(ctx, { kind: 'patients', fileName: 'x.csv', bytes }, NOW);
    expect(await statuses(ctx, id)).toEqual(['error']);

    const batch = await withTx(ctx, (tx) => getImportBatch(tx, f.facilityId, id));
    const mapping = batch.mapping.map((m, i) =>
      batch.headers[i] === 'Contact Person Phone' ? 'mobile' : m,
    );
    await remapImportBatch(ctx, { batchId: id, mapping }, NOW);
    expect(await statuses(ctx, id)).toEqual(['ok']);
    await commitImportBatch(ctx, id, NOW);
    const [p] = await t.app.select().from(patient).where(eq(patient.facilityId, f.facilityId));
    expect(p).toMatchObject({ firstName: 'Réka', mobile: '9877700001' });

    await expect(remapImportBatch(ctx, { batchId: id, mapping }, NOW)).rejects.toMatchObject({
      key: 'import.notEditable',
    });
  });

  it('rejects invalid mappings and unusable files', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      {
        kind: 'patients',
        fileName: 'x.csv',
        bytes: csvBytes('Name,Age,Sex,Mobile\nA B,30,F,9877700001\n'),
      },
      NOW,
    );
    await expect(
      remapImportBatch(ctx, { batchId: id, mapping: ['mobile', 'mobile', null, null] }, NOW),
    ).rejects.toMatchObject({ key: 'import.mappingInvalid' });
    await expect(
      remapImportBatch(ctx, { batchId: id, mapping: ['nonsense', null, null, null] }, NOW),
    ).rejects.toMatchObject({ key: 'import.mappingInvalid' });
    await expect(
      remapImportBatch(ctx, { batchId: id, mapping: ['mobile'] }, NOW),
    ).rejects.toMatchObject({ key: 'import.mappingInvalid' });

    await expect(
      createImportBatch(
        ctx,
        { kind: 'patients', fileName: 'x.csv', bytes: csvBytes('foo,bar\n1,2\n') },
        NOW,
      ),
    ).rejects.toMatchObject({ key: 'import.fileNoHeader' });
    await expect(
      createImportBatch(
        ctx,
        { kind: 'patients', fileName: 'x.csv', bytes: csvBytes('Name,Mobile\n') },
        NOW,
      ),
    ).rejects.toMatchObject({ key: 'import.fileEmpty' });
    await expect(
      createImportBatch(
        ctx,
        { kind: 'patients', fileName: 'x.xlsx', bytes: csvBytes('not a zip') },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ImportError);
    await expect(
      createImportBatch(ctx, { kind: 'patients', fileName: 'x.pdf', bytes: csvBytes('%PDF') }, NOW),
    ).rejects.toMatchObject({ key: 'import.fileInvalid' });
    // Other facilities cannot see the batch.
    const other = await seedFacility(t.owner);
    await expect(
      withTx({ db: t.app, userId: other.userId, facilityId: other.facilityId }, (tx) =>
        getImportBatch(tx, other.facilityId, id),
      ),
    ).rejects.toMatchObject({ key: 'import.notFound' });
    expect(f.facilityId).not.toBe(other.facilityId);
  });

  it('imports rows without a mobile only when the option says so', async () => {
    const { f, ctx } = await facilityWithMasters();
    const bytes = csvBytes('Name,Age,Sex,Mobile\nAsha Devi,40,F,\n');
    const strict = await createImportBatch(
      ctx,
      { kind: 'patients', fileName: 'x.csv', bytes },
      NOW,
    );
    expect(await statuses(ctx, strict)).toEqual(['error']);
    const lenient = await createImportBatch(
      ctx,
      { kind: 'patients', fileName: 'x.csv', bytes, options: { allowMissingMobile: true } },
      NOW,
    );
    expect(await statuses(ctx, lenient)).toEqual(['ok']);
    await commitImportBatch(ctx, lenient, NOW);
    const [p] = await t.app.select().from(patient).where(eq(patient.facilityId, f.facilityId));
    expect(p).toMatchObject({ mobile: null, noMobileReason: 'Not in old register' });
  });

  it('cancelling keeps the batch with a reason and blocks the commit', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      {
        kind: 'patients',
        fileName: 'x.csv',
        bytes: csvBytes('Name,Age,Sex,Mobile\nA B,30,F,9877700001\n'),
      },
      NOW,
    );
    await cancelImportBatch(ctx, id, 'wrong file');
    const [b] = await t.app.select().from(importBatch).where(eq(importBatch.id, id));
    expect(b).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      cancelReason: 'wrong file',
    });
    await expect(commitImportStep(ctx, id, NOW)).rejects.toMatchObject({
      key: 'import.notEditable',
    });
    const n = await t.app
      .select({ n: sql<number>`count(*)::int` })
      .from(patient)
      .where(eq(patient.facilityId, f.facilityId));
    expect(n[0]!.n).toBe(0);
  });
});

describe('rate list import (MIG-01)', () => {
  const HEAD = ['Code', 'Particulars', 'Type', 'Tariff', 'Rate', 'W.E.F', 'GST %'];
  const rateSheet = (): Cell[][] => [
    ['Rate list 2026', null, null, null, null, null, null],
    HEAD,
    [
      'CONS-GYN-NEW',
      'Gynae consultation – new',
      'OPD consultation',
      'Standard (Cash)',
      '₹ 500/-',
      '01/04/2026',
      'Exempt',
    ], // 3: existing code? depends on seed
    ['NEW-DRESS-L', 'Dressing (large)', 'procedure', 'standard (cash)', 350.5, '01-04-2026', 0], // 4 new service
    ['NEW-DRESS-L', 'Dressing (large)', 'procedure', 'Standard (Cash)', '350.50', '01/04/2026', 0], // 5 same row again
    ['NEW-DRESS-L', 'Dressing (large)', 'procedure', 'Standard (Cash)', '400', '01/04/2026', 0], // 6 conflicting rate
    ['NEW-XRAY', 'X-ray chest', 'radiology', 'Standard (Cash)', '300', '01/04/2026', ''], // 7 bad category
    ['NEW-INJ', 'Injection charge', 'procedure', 'Premium', '50', '01/04/2026', ''], // 8 unknown tariff
    ['NEW-NEB', 'Nebulisation', 'procedure', 'Standard (Cash)', '120.456', '01/04/2026', ''], // 9 too many decimals
    ['NEW-NEB2', 'Nebulisation (child)', 'procedure', 'Standard (Cash)', '120', '', ''], // 10 no date
  ];

  it('dry-runs: new service, replaced rate, duplicates, conflicts and bad references', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      { kind: 'services_rates', fileName: 'rates.xlsx', bytes: await xlsx(rateSheet()) },
      NOW,
    );
    const rows = await rowsOf(ctx, id);
    expect(rows.map((r) => [r.sourceRow, r.status])).toEqual([
      [3, 'ok'],
      [4, 'ok'],
      [5, 'duplicate'],
      [6, 'error'],
      [7, 'error'],
      [8, 'error'],
      [9, 'error'],
      [10, 'error'],
    ]);
    expect(codes(rows[3]!)).toContain('rateConflictInFile');
    expect(codes(rows[4]!)).toContain('categoryInvalid');
    expect(codes(rows[5]!)).toContain('tariffNotFound');
    expect(codes(rows[6]!)).toContain('rateInvalid');
    expect(codes(rows[7]!)).toContain('dateRequired');
    expect(rows[1]!.preview).toMatchObject({
      code: 'NEW-DRESS-L',
      rate: '₹350.50',
      service: 'new',
    });
    // Dry run wrote no master data.
    const svc = await t.app
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, 'NEW-DRESS-L')));
    expect(svc).toHaveLength(0);
  });

  it('commits exact paise, creates the service, and replaces / keeps rates correctly', async () => {
    const { f, ctx } = await facilityWithMasters();
    const id = await createImportBatch(
      ctx,
      { kind: 'services_rates', fileName: 'rates.xlsx', bytes: await xlsx(rateSheet()) },
      NOW,
    );
    await commitImportBatch(ctx, id, NOW);

    const [svc] = await t.app
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, 'NEW-DRESS-L')));
    expect(svc).toMatchObject({
      name: 'Dressing (large)',
      category: 'procedure',
      isExempt: true,
      defaultGstRateBp: 0,
      unit: 'per_visit',
    });
    const tariffId = (
      await t.app.execute<{ id: string }>(
        sql`select id from tariff where facility_id = ${f.facilityId} and name = 'Standard (Cash)'`,
      )
    ).rows[0]!.id;
    const rate = await getRate(t.app, {
      facilityId: f.facilityId,
      serviceId: svc!.id,
      tariffId,
      on: '2026-10-26',
    });
    expect(rate?.ratePaise).toBe(35050n);

    const cons = await t.app
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, 'CONS-GYN-NEW')));
    const consRate = await getRate(t.app, {
      facilityId: f.facilityId,
      serviceId: cons[0]!.id,
      tariffId,
      on: '2026-10-26',
    });
    expect(consRate?.ratePaise).toBe(rupeesToPaise('500'));

    const after = await rowsOf(ctx, id);
    expect(after.map((r) => r.status)).toEqual([
      'committed',
      'committed',
      'duplicate',
      'error',
      'error',
      'error',
      'error',
      'error',
    ]);

    // Same file again: nothing changes any more.
    const again = await createImportBatch(
      ctx,
      { kind: 'services_rates', fileName: 'rates.xlsx', bytes: await xlsx(rateSheet()) },
      NOW,
    );
    expect((await rowsOf(ctx, again)).map((r) => r.status).slice(0, 2)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    const result = await commitImportBatch(ctx, again, NOW);
    expect(result.counts.committed ?? 0).toBe(0);
    const rates = await t.app
      .select()
      .from(serviceRate)
      .where(and(eq(serviceRate.serviceId, svc!.id), eq(serviceRate.status, 'active')));
    expect(rates).toHaveLength(1);
  });

  it('a corrected rate for the same date cancels the old row instead of overwriting it', async () => {
    const { f, ctx } = await facilityWithMasters();
    const head = [
      'service_code',
      'service_name',
      'category',
      'tariff_name',
      'rate_inr',
      'effective_from',
    ];
    const one = (rate: string) =>
      xlsx([head, ['SVC-ONE', 'One', 'misc', 'Standard (Cash)', rate, '2026-04-01']], 'Data');
    await commitImportBatch(
      ctx,
      await createImportBatch(
        ctx,
        { kind: 'services_rates', fileName: 'a.xlsx', bytes: await one('100') },
        NOW,
      ),
      NOW,
    );

    const second = await createImportBatch(
      ctx,
      { kind: 'services_rates', fileName: 'b.xlsx', bytes: await one('1000') },
      NOW,
    );
    const [row] = await rowsOf(ctx, second);
    expect(row!.status).toBe('ok');
    expect(codes(row!)).toContain('rateChangeLarge'); // 10x: probably a typo, flagged for the user
    expect(row!.preview.oldRate).toBe('₹100.00');
    await commitImportBatch(ctx, second, NOW);

    const [svc] = await t.app
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, 'SVC-ONE')));
    const all = await t.app.select().from(serviceRate).where(eq(serviceRate.serviceId, svc!.id));
    expect(all.map((r) => [r.ratePaise, r.status]).sort()).toEqual([
      [10000n, 'cancelled'],
      [100000n, 'active'],
    ]);
  });

  it('a row that cannot be saved is marked failed and the rest still commit', async () => {
    const { f, ctx } = await facilityWithMasters();
    const head = [
      'service_code',
      'service_name',
      'category',
      'tariff_name',
      'rate_inr',
      'effective_from',
    ];
    const id = await createImportBatch(
      ctx,
      {
        kind: 'services_rates',
        fileName: 'x.xlsx',
        bytes: await xlsx(
          [
            head,
            ['SVC-A', 'Alpha', 'misc', 'Standard (Cash)', '10', '2026-04-01'],
            ['SVC-B', 'Bravo', 'misc', 'Standard (Cash)', '20', '2026-04-01'],
          ],
          'Data',
        ),
      },
      NOW,
    );
    // The tariff is cancelled after the dry run, before the commit.
    await t.owner.execute(
      sql`update tariff set status = 'cancelled', cancel_reason = 'x', cancelled_at = now() where facility_id = ${f.facilityId}`,
    );
    const out = await commitImportBatch(ctx, id, NOW);
    expect(out.counts).toEqual({ failed: 2 });
    const rows = await rowsOf(ctx, id);
    expect(rows.every((r) => codes(r).includes('tariffNotFound'))).toBe(true);
    const made = await t.app
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), sql`${service.code} like 'SVC-%'`));
    expect(made).toHaveLength(0); // the failed row's service insert was rolled back with its savepoint
  });

  it('applies a default effective date and refuses room-specific rates', async () => {
    const { ctx } = await facilityWithMasters();
    const head = [
      'service_code',
      'service_name',
      'category',
      'tariff_name',
      'rate_inr',
      'room_category',
    ];
    const bytes = await xlsx(
      [
        head,
        ['SVC-C', 'Charlie', 'misc', 'Standard (Cash)', '10', ''],
        ['SVC-D', 'Delta', 'bed', 'Standard (Cash)', '900', 'Deluxe'],
      ],
      'Data',
    );
    const id = await createImportBatch(
      ctx,
      { kind: 'services_rates', fileName: 'x.xlsx', bytes },
      NOW,
    );
    expect((await rowsOf(ctx, id)).map((r) => r.status)).toEqual(['error', 'error']);
    await remapImportBatch(
      ctx,
      { batchId: id, options: { defaultEffectiveFrom: '2026-10-26' } },
      NOW,
    );
    const rows = await rowsOf(ctx, id);
    expect(rows.map((r) => r.status)).toEqual(['ok', 'error']);
    expect(codes(rows[0]!)).toContain('dateDefaulted');
    expect(codes(rows[1]!)).toContain('roomCategoryUnsupported');
  });
});

describe('the committed Excel templates (docs/33 §9)', () => {
  async function filled(file: string, rows: Cell[][]): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(`${TEMPLATE_DIR}/${file}`);
    const data = wb.getWorksheet('Data')!;
    rows.forEach((r) => data.addRow(r));
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }

  it('patients.xlsx filled in imports as is (the Instructions sheet is ignored)', async () => {
    const { f, ctx } = await facilityWithMasters();
    const bytes = await filled('patients.xlsx', [
      [
        'OLD-9',
        'Sunita',
        '',
        'Verma',
        'F',
        '1994-07-01',
        '',
        '9000012345',
        'self',
        'Ramesh Verma',
        'husband',
        'Ward 4',
        'Rampur',
        'Lucknow',
        'Uttar Pradesh',
        '226001',
        'B+',
      ],
    ]);
    const id = await createImportBatch(
      ctx,
      { kind: 'patients', fileName: 'patients.xlsx', bytes },
      NOW,
    );
    const batch = await withTx(ctx, (tx) => getImportBatch(tx, f.facilityId, id));
    expect(batch.mapping.every((m) => m !== null)).toBe(true);
    expect(await statuses(ctx, id)).toEqual(['ok']);
    await commitImportBatch(ctx, id, NOW);
    const [p] = await t.app.select().from(patient).where(eq(patient.facilityId, f.facilityId));
    expect(p).toMatchObject({
      fullName: 'Sunita Verma',
      dob: '1994-07-01',
      pincode: '226001',
      bloodGroup: 'B+',
      guardianRelation: 'husband',
      district: 'Lucknow',
    });
  });

  it('services_rates.xlsx filled in imports as is, with GST, SAC and Hindi name', async () => {
    const { f, ctx } = await facilityWithMasters();
    const bytes = await filled('services_rates.xlsx', [
      [
        'TST-NEW',
        'Test service',
        'परीक्षण सेवा',
        'procedure',
        'GYN',
        'per_visit',
        '9993',
        '18',
        'Standard (Cash)',
        '',
        '1250.50',
        '2026-04-01',
      ],
    ]);
    const id = await createImportBatch(
      ctx,
      { kind: 'services_rates', fileName: 'services_rates.xlsx', bytes },
      NOW,
    );
    expect(await statuses(ctx, id)).toEqual(['ok']);
    await commitImportBatch(ctx, id, NOW);
    const [s] = await t.app
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, 'TST-NEW')));
    expect(s).toMatchObject({
      nameHi: 'परीक्षण सेवा',
      sacCode: '9993',
      defaultGstRateBp: 1800,
      isExempt: false,
    });
    const [r] = await t.app.select().from(serviceRate).where(eq(serviceRate.serviceId, s!.id));
    expect(r!.ratePaise).toBe(125050n);
  });
});
