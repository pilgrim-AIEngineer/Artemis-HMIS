import { facility, setting } from '@hmis/db/schema';
import { seedFacility, setupPlatformDb, type PlatformTestDb } from '@hmis/db/testing/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PAPER_SIZES, type PaperSize } from './paper';
import { initials } from './doc-utils';
import { renderPrintHtml } from './render';
import { preparePrintDocument } from './server';
import { embeddedFontCss } from './node';
import { PRINT_TEMPLATE_METAS, sampleTemplateKey } from './templates/meta';
import { printCss } from './styles';

let t: PlatformTestDb;
let facilityId: string;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
  ({ facilityId } = await seedFacility(t.owner));
  await t.owner
    .update(facility)
    .set({
      name: 'City Mother & Child Hospital',
      address: '12 Station Road',
      district: 'Lucknow',
      state: 'Uttar Pradesh',
      pincode: '226001',
      phone: '0522 123456',
      clinicalEstablishmentRegNo: 'CE/UP/1234',
      gstin: '09ABCDE1234F1Z5',
    })
    .where(eq(facility.id, facilityId));
  await t.owner.insert(setting).values({
    facilityId,
    key: 'print.header',
    value: { nameHi: 'सिटी मदर एंड चाइल्ड हॉस्पिटल', taglineEn: 'Care with dignity' },
  });
});

afterAll(async () => {
  await t.close();
});

const prepare = (paper: PaperSize, copyNo: number, entityId = facilityId) =>
  preparePrintDocument({
    db: t.app,
    facilityId,
    template: sampleTemplateKey(paper),
    entityId,
    copyNo,
    printedAt: new Date('2026-10-25T05:30:00Z'),
    printedByName: 'Asha Singh',
  });

describe('print templates (FND-06)', () => {
  it('registers a sample template per paper size', () => {
    expect(PRINT_TEMPLATE_METAS.map((m) => m.paper).sort()).toEqual(
      Object.keys(PAPER_SIZES).sort(),
    );
  });

  it('emits @page rules for every paper size', () => {
    expect(printCss('thermal80')).toContain('@page { margin: 3mm; }');
    expect(printCss('thermal80').split('\n')[0]).toBe('@page { margin: 3mm; }');
    expect(printCss('a5')).toContain('@page { size: 148mm 210mm; margin: 8mm; }');
    expect(printCss('a4')).toContain('@page { size: 210mm 297mm; margin: 12mm; }');
    expect(printCss('label50x25')).toContain('@page { size: 50mm 25mm; margin: 1mm; }');
  });

  it.each(Object.keys(PAPER_SIZES) as PaperSize[])(
    'renders %s from the database',
    async (paper) => {
      const doc = await prepare(paper, 1);
      expect(doc).not.toBeNull();
      const html = renderPrintHtml(doc!, embeddedFontCss());
      expect(html).toContain(`print-paper-${paper}`);
      expect(html).toContain('@font-face');
      expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(html).not.toContain('duplicate-watermark');
      if (paper !== 'label50x25') {
        // Header: Hindi name first, English second, address, phone, registration numbers.
        expect(html.indexOf('<h1 class="print-name-hi">सिटी मदर')).toBeLessThan(
          html.indexOf('<h1 class="print-name">City Mother &amp; Child'),
        );
        expect(html).toContain('12 Station Road, Lucknow, Uttar Pradesh, 226001');
        expect(html).toContain('0522 123456');
        expect(html).toContain('CE/UP/1234');
        expect(html).toContain('<svg'); // QR in the footer
        expect(html).toContain('25-Oct-2026 11:00'); // IST
        expect(html).toContain('AS'); // initials
        expect(html).toContain('₹2,534.56'); // 50,000 + 80,000 + 123,456 paise
      }
    },
  );

  it('marks reprints DUPLICATE with the copy number, originals never', async () => {
    const original = renderPrintHtml((await prepare('a5', 1))!, '');
    const reprint = renderPrintHtml((await prepare('a5', 3))!, '');
    expect(original).not.toContain('duplicate-watermark');
    expect(reprint).toContain('duplicate-watermark');
    expect(reprint).toContain('DUPLICATE');
    expect(reprint).toContain('#3');
    const label = renderPrintHtml((await prepare('label50x25', 2))!, '');
    expect(label).toContain('duplicate-watermark');
  });

  it('returns null for an unknown template or another facility entity', async () => {
    expect(await prepare('a4', 1, crypto.randomUUID())).toBeNull();
    expect(
      await preparePrintDocument({
        db: t.app,
        facilityId,
        template: 'nope',
        entityId: facilityId,
        copyNo: 1,
        printedAt: new Date(),
        printedByName: 'X',
      }),
    ).toBeNull();
  });

  it('derives initials', () => {
    expect(initials('Asha Singh')).toBe('AS');
    expect(initials('  priya ')).toBe('P');
    expect(initials('Dr. A. K. Verma')).toBe('DA');
    expect(initials('')).toBe('?');
  });
});
