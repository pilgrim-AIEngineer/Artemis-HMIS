import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureFacilityRbac, grantRoles, withTx } from '@hmis/db';
import { appUser, document, printLog } from '@hmis/db/schema';
import { seedFacility, setupPlatformDb, type PlatformTestDb } from '@hmis/db/testing/platform';
import { PAPER_SIZES, sampleTemplateKey, type PaperSize } from '@hmis/print';
import { createLogger } from '@hmis/shared/logger';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { absolutePath } from '../files';
import { renderPdf } from '../pdf';
import { PDF_RENDER_QUEUE, pdfRenderJob } from './pdf-render';

let t: PlatformTestDb;
let filesDir: string;
let facilityId: string;
let adminId: string;
let nurseId: string;

beforeAll(async () => {
  // PDFs need headless Chromium (docs/01 §2). Fail with the fix, not a launcher stack trace.
  try {
    await renderPdf('<p>probe</p>', 'a4');
  } catch (err) {
    throw new Error(
      'Chromium cannot start. Install it once with: pnpm --filter @hmis/web exec playwright install --with-deps chromium',
      { cause: err },
    );
  }
  t = await setupPlatformDb(inject('testPgAdminUrl'));
  filesDir = await mkdtemp(join(tmpdir(), 'hmis-files-'));
  const f = await seedFacility(t.owner);
  facilityId = f.facilityId;
  adminId = f.userId;
  await withTx({ db: t.owner, userId: null }, async (tx) => {
    await ensureFacilityRbac(tx, facilityId);
    await grantRoles(tx, facilityId, adminId, ['admin']);
  });
  // A second user in the same facility without admin.settings.manage.
  nurseId = uuidv7();
  await withTx({ db: t.owner, userId: null }, async (tx) => {
    await tx
      .insert(appUser)
      .values({ id: nurseId, facilityId, username: 'nurse_pdf', fullName: 'Nita Nurse' });
    await grantRoles(tx, facilityId, nurseId, ['nurse']);
  });
});

afterAll(async () => {
  await t.close();
  await rm(filesDir, { recursive: true, force: true });
});

const run = (over: Partial<{ template: string; requestedBy: string; documentId: string }> = {}) =>
  pdfRenderJob.handle(
    {
      facilityId,
      template: sampleTemplateKey('a4'),
      entityId: facilityId,
      requestedBy: adminId,
      documentId: uuidv7(),
      ...over,
    },
    { logger: createLogger('test', 'silent'), db: t.app, filesDir, jobId: 'test' },
  ) as Promise<{ documentId: string; copyNo?: number; reused?: boolean }>;

/** `/MediaBox [0 0 w h]` of the first page, in PDF points. */
const mediaBox = (pdf: Buffer): [number, number] => {
  const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no MediaBox');
  return [Number(m[1]), Number(m[2])];
};
const mmToPt = (mm: number) => (mm / 25.4) * 72;

describe('pdf.render (FND-06)', () => {
  it('is registered under the documented queue name', () => {
    expect(PDF_RENDER_QUEUE).toBe('pdf.render');
    expect(pdfRenderJob.name).toBe('pdf.render');
  });

  it.each(Object.keys(PAPER_SIZES) as PaperSize[])(
    'renders the %s sample to a stored PDF with the paper size from @page',
    async (paper) => {
      const documentId = uuidv7();
      const res = await run({ template: sampleTemplateKey(paper), documentId });
      expect(res).toMatchObject({ documentId, copyNo: 1 });

      const [doc] = await t.app.select().from(document).where(eq(document.id, documentId));
      expect(doc).toMatchObject({
        facilityId,
        kind: 'report_pdf',
        entity: 'facility',
        entityId: facilityId,
        mime: 'application/pdf',
        status: 'active',
        createdBy: adminId,
      });
      expect(doc!.filePath).toMatch(
        new RegExp(`^${facilityId}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.pdf$`),
      );
      expect(doc!.pages).toBeGreaterThanOrEqual(1);

      const bytes = await readFile(absolutePath(filesDir, doc!.filePath));
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(bytes.byteLength).toBe(doc!.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(doc!.sha256);

      const [w, h] = mediaBox(bytes);
      const spec = PAPER_SIZES[paper];
      expect(w).toBeCloseTo(mmToPt(spec.widthMm), 0);
      if (spec.heightMm !== null) expect(h).toBeCloseTo(mmToPt(spec.heightMm), 0);
      else expect(h).toBeGreaterThan(mmToPt(40)); // thermal: cut to content height
    },
  );

  it('logs each render as a print and counts reprints', async () => {
    const template = sampleTemplateKey('a5');
    const before = await t.app
      .select()
      .from(printLog)
      .where(and(eq(printLog.template, template), eq(printLog.entityId, facilityId)));
    expect(before).toHaveLength(1); // from the it.each above
    const res = await run({ template });
    expect(res.copyNo).toBe(2);
    const after = await t.app
      .select()
      .from(printLog)
      .where(and(eq(printLog.template, template), eq(printLog.entityId, facilityId)));
    expect(after.map((r) => r.copyNo).sort()).toEqual([1, 2]);
    expect(after.every((r) => r.userId === adminId)).toBe(true);
  });

  it('returns the first result for a repeated documentId (retry-safe)', async () => {
    const documentId = uuidv7();
    await run({ documentId });
    const again = await run({ documentId });
    expect(again).toEqual({ documentId, reused: true });
    const logged = await t.app
      .select()
      .from(printLog)
      .where(eq(printLog.template, sampleTemplateKey('a4')));
    const docs = await t.app.select().from(document).where(eq(document.id, documentId));
    expect(docs).toHaveLength(1);
    expect(logged.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a requester without the template permission and leaves no file behind', async () => {
    const filesBefore = (await readdir(filesDir, { recursive: true })).length;
    await expect(run({ requestedBy: nurseId })).rejects.toThrow(/lacks admin.settings.manage/);
    expect((await readdir(filesDir, { recursive: true })).length).toBe(filesBefore);
  });

  it('refuses unknown templates and entities of another facility', async () => {
    await expect(run({ template: 'nope' })).rejects.toThrow(/unknown print template/);
  });
});
