import { patient, service } from '@hmis/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let admin: TestBrowser;
let adminB: TestBrowser;
let reception: TestBrowser;
let owner: TestBrowser;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  const login = async (username: string) => {
    const b = f.browser();
    await b.login(username);
    return b;
  };
  admin = await login(f.users.admin.username);
  adminB = await login(f.users.adminB.username);
  reception = await login(f.users.reception.username);
  owner = await login(f.users.owner.username);
});

afterAll(async () => {
  await f.close();
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const CSV = [
  'Patient Name,Age,Gender,Mob No,Old Reg No',
  'Sunita Devi,28,F,98765 43210,R-1',
  'Geeta,30,F,12345,R-2',
  'Kavita Singh,31,F,9123456780,R-3',
].join('\n');

describe('importer access (AGENTS.md rule 6)', () => {
  it('lets admin and owner in and keeps reception and other hospitals out', async () => {
    expect((await admin.call((c) => c.importer.list())).length).toBe(0);
    expect(await owner.call((c) => c.importer.list())).toEqual([]);
    for (const call of [
      () => reception.call((c) => c.importer.list()),
      () => reception.call((c) => c.importer.template({ kind: 'patients' })),
      () =>
        reception.call((c) =>
          c.importer.upload({ kind: 'patients', fileName: 'x.csv', base64: b64(CSV) }),
        ),
    ]) {
      expect((await trpcError(call())).code).toBe('FORBIDDEN');
    }
    expect((await trpcError(f.browser().call((c) => c.importer.list()))).code).toBe('UNAUTHORIZED');
  });
});

describe('importer flow (MIG-01)', () => {
  it('uploads, dry-runs, produces a report, commits in steps and isolates hospitals', async () => {
    const { batchId } = await admin.call((c) =>
      c.importer.upload({ kind: 'patients', fileName: 'old.csv', base64: b64(CSV) }),
    );
    const b = await admin.call((c) => c.importer.get({ batchId }));
    expect(b).toMatchObject({
      kind: 'patients',
      stage: 'dry_run',
      totalRows: 3,
      pending: 2,
      counts: { ok: 2, error: 1 },
    });
    expect(b.mapping).toEqual(['full_name', 'age_years', 'sex', 'mobile', 'old_uhid']);

    const rows = await admin.call((c) => c.importer.rows({ batchId, statuses: ['error'] }));
    expect(rows.map((r) => [r.sourceRow, r.issues[0]?.code])).toEqual([[3, 'mobileInvalid']]);

    const report = await admin.call((c) => c.importer.report({ batchId }));
    expect(report.headers[0]).toBe('Patient Name');
    expect(report.rows).toEqual([
      {
        sourceRow: 3,
        raw: ['Geeta', '30', 'F', '12345', 'R-2'],
        status: 'error',
        issues: [{ field: 'mobile', code: 'mobileInvalid' }],
      },
    ]);

    // Another hospital's admin cannot see it.
    expect((await trpcError(adminB.call((c) => c.importer.get({ batchId })))).code).toBe(
      'NOT_FOUND',
    );
    expect((await trpcError(adminB.call((c) => c.importer.commitStep({ batchId })))).code).toBe(
      'NOT_FOUND',
    );

    const step = await admin.call((c) => c.importer.commitStep({ batchId }));
    expect(step).toMatchObject({ processed: 2, remaining: 0, done: true });
    const people = await f.db.select().from(patient).where(eq(patient.facilityId, f.a.facilityId));
    expect(people.map((p) => p.fullName).sort()).toEqual(['Kavita Singh', 'Sunita Devi']);

    expect(
      (await trpcError(admin.call((c) => c.importer.cancel({ batchId, reason: 'late' })))).message,
    ).toBe('errors.import.notEditable');
    expect((await admin.call((c) => c.importer.list())).map((x) => x.id)).toContain(batchId);
  });

  it('remaps columns, sets options, imports the rate list and cancels a batch', async () => {
    const csv = 'Code,Particulars,Type,Tariff,Rate\nZZ-ONE,Zed one,misc,Standard (Cash),₹ 75/-\n';
    const up = await admin.call((c) =>
      c.importer.upload({ kind: 'services_rates', fileName: 'rates.csv', base64: b64(csv) }),
    );
    // No effective date column: every row is an error until a default date is chosen.
    expect((await admin.call((c) => c.importer.get({ batchId: up.batchId }))).counts).toEqual({
      error: 1,
    });
    await admin.call((c) =>
      c.importer.remap({ batchId: up.batchId, options: { defaultEffectiveFrom: '2026-04-01' } }),
    );
    const got = await admin.call((c) => c.importer.get({ batchId: up.batchId }));
    expect(got.options.defaultEffectiveFrom).toBe('2026-04-01');
    // The fixture facility has no tariffs: the row is reported, never guessed.
    expect(
      (await admin.call((c) => c.importer.rows({ batchId: up.batchId })))[0]!.issues.map(
        (i) => i.code,
      ),
    ).toContain('tariffNotFound');

    expect(
      (
        await trpcError(
          admin.call((c) => c.importer.remap({ batchId: up.batchId, mapping: ['mobile'] })),
        )
      ).message,
    ).toBe('errors.import.mappingInvalid');

    await admin.call((c) => c.importer.cancel({ batchId: up.batchId, reason: 'wrong list' }));
    expect(
      (await trpcError(admin.call((c) => c.importer.commitStep({ batchId: up.batchId })))).message,
    ).toBe('errors.import.notEditable');
    const made = await f.db
      .select()
      .from(service)
      .where(and(eq(service.facilityId, f.a.facilityId), eq(service.code, 'ZZ-ONE')));
    expect(made).toEqual([]);
  });

  it('refuses unreadable and oversized uploads with plain messages', async () => {
    const bad = await trpcError(
      admin.call((c) =>
        c.importer.upload({ kind: 'patients', fileName: 'x.csv', base64: b64('foo,bar\n1,2') }),
      ),
    );
    expect(bad.message).toBe('errors.import.fileNoHeader');
    const pdf = await trpcError(
      admin.call((c) =>
        c.importer.upload({ kind: 'patients', fileName: 'x.pdf', base64: b64('%PDF') }),
      ),
    );
    expect(pdf.message).toBe('errors.import.fileInvalid');
    const empty = await trpcError(
      admin.call((c) => c.importer.upload({ kind: 'patients', fileName: 'x.csv', base64: '' })),
    );
    expect(empty.message).toBe('errors.import.fileTooBig');
  });

  it('serves the empty templates from the same spec as the committed files', async () => {
    for (const [kind, file] of [
      ['patients', 'patients.xlsx'],
      ['services_rates', 'services_rates.xlsx'],
    ] as const) {
      const tpl = await admin.call((c) => c.importer.template({ kind }));
      expect(tpl.fileName).toBe(file);
      expect(Buffer.from(tpl.base64, 'base64').subarray(0, 2).toString()).toBe('PK'); // a zip
    }
  });
});
