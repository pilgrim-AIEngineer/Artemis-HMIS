/**
 * REG-06 / REG-07: OPD sheet, patient sticker and UHID card rendered from the database. Synthetic
 * patients only. The QR payloads are checked on `PrintMeta.docRef` (what the QR encodes).
 */
import { encounter, opdToken, patient, setting } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import { issueToken, writeSetting } from '@hmis/db';
import { DEFAULT_QUICK_ORDERS, parseVisitQr } from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrintPage } from './components/print-page';
import { renderPrintHtml } from './render';
import { preparePrintDocument } from './server';
import { OPD_SHEET_TEMPLATE, PATIENT_STICKER_TEMPLATE, UHID_CARD_TEMPLATE } from './templates/meta';
import { embeddedFontCss } from './node';

let fx: OpdFixture;
let patientId: string;
let encounterId: string;
let at: Date;

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  at = IST('2028-05-03T10:42:00');
  patientId = await fx.newPatient();
  await fx.t.app
    .update(patient)
    .set({
      uhid: 'UH-000123',
      firstName: 'Radha',
      lastName: 'Devi',
      nameHi: 'राधा देवी',
      dob: '1996-02-10',
      mobile: '9876543210',
      guardianName: 'Mohan Lal',
    })
    .where(eq(patient.id, patientId));
  const v = await fx.visit({ patientId, doctorId: fx.doctorA }, at);
  encounterId = v.encounterId;
  await fx.run((tx) => issueToken(tx, fx.actor(), encounterId, 'manual_fee_pending', at));
});
afterAll(async () => {
  await fx.t.close();
});

const prepare = (template: string, entityId: string, copyNo = 1, facilityId = fx.f.facilityId) =>
  preparePrintDocument({
    db: fx.t.app,
    facilityId,
    template,
    entityId,
    copyNo,
    printedAt: IST('2028-05-03T11:00:00'),
    printedByName: 'Asha Singh',
  });

describe('OPD sheet (REG-06)', () => {
  it('encodes the visit id only in the QR and prints the visit’s data', async () => {
    const doc = (await prepare(OPD_SHEET_TEMPLATE, encounterId))!;
    expect(doc.template.paper).toBe('a5');
    expect(doc.meta.docRef).toBe(`E:${encounterId}`);
    expect(parseVisitQr(doc.meta.docRef)).toBe(encounterId);
    // The QR carries no patient data: the payload is exactly E:<uuid>.
    expect(doc.meta.docRef).not.toMatch(/Radha|9876|UH-000123/);

    const html = renderPrintHtml(doc, embeddedFontCss());
    expect(html).toContain('Radha Devi');
    expect(html).toContain('राधा देवी');
    expect(html).toContain('UH-000123');
    expect(html).toContain('Mohan Lal');
    expect(html).toContain('XXXXXX3210'); // mobile: last four digits only
    expect(html).not.toContain('9876543210');
    expect(html).toContain('32y / F');
    expect(html).toContain('Dr. A');
    expect(html).toContain('03-May-2028 10:42');
    expect(html).toMatch(/OP\/\d\d-\d\d\/\d{6}/); // visit number, also as a barcode
    expect(html).toContain('aria-label="OP/'); // barcode
    expect(html).toContain('First visit'); // no earlier visit
    expect(html).toContain('<svg'); // QR
  });

  it('has blank vitals boxes, the default quick orders and compact framing', async () => {
    const html = renderToStaticMarkup(
      <PrintPage doc={(await prepare(OPD_SHEET_TEMPLATE, encounterId))!} />,
    );
    expect(html).toContain('print-header-compact');
    expect(html).not.toContain('<h2'); // the sheet is its own title
    expect(html).not.toContain('<div class="print-qr"'); // the QR is in the body, once
    expect(html.match(/class="sheet-qr"/g)).toHaveLength(1);
    expect(html.match(/class="sheet-vital-box"><\/span>/g)).toHaveLength(5);
    for (const o of DEFAULT_QUICK_ORDERS) expect(html).toContain(o);
    expect(html).toContain('Next visit');
    expect(html).toContain('Doctor&#x27;s signature');
  });

  it('uses the doctor’s own quick-order list when configured, capped to 20', async () => {
    const own = Array.from({ length: 25 }, (_, i) => `Test ${i + 1}`);
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'opd.quickOrders', { [fx.doctorA]: own }),
    );
    try {
      const html = renderPrintHtml((await prepare(OPD_SHEET_TEMPLATE, encounterId))!, '');
      expect(html).toContain('Test 20');
      expect(html).not.toContain('Test 21');
      expect(html).not.toContain('Obstetric USG');
    } finally {
      await fx.t.owner.delete(setting).where(eq(setting.key, 'opd.quickOrders'));
    }
  });

  it('shows the last visit of a returning patient', async () => {
    const later = IST('2028-05-10T09:00:00');
    const v2 = await fx.visit({ patientId, doctorId: fx.doctorA, allowRepeatToday: true }, later);
    const html = renderPrintHtml((await prepare(OPD_SHEET_TEMPLATE, v2.encounterId))!, '');
    expect(html).toContain('03-May-2028 · Dr. A');
    expect(html).not.toContain('First visit');
  });

  it('marks reprints DUPLICATE', async () => {
    const html = renderPrintHtml((await prepare(OPD_SHEET_TEMPLATE, encounterId, 2))!, '');
    expect(html).toContain('duplicate-watermark');
  });

  it('refuses cancelled visits, other facilities and non-visits', async () => {
    const p2 = await fx.newPatient();
    const v = await fx.visit({ patientId: p2, doctorId: fx.doctorB }, at);
    await fx.t.owner
      .update(encounter)
      .set({ status: 'cancelled', cancelReason: 'test', cancelledAt: at })
      .where(eq(encounter.id, v.encounterId));
    expect(await prepare(OPD_SHEET_TEMPLATE, v.encounterId)).toBeNull();
    expect(await prepare(OPD_SHEET_TEMPLATE, patientId)).toBeNull();
    expect(await prepare(OPD_SHEET_TEMPLATE, encounterId, 1, crypto.randomUUID())).toBeNull();
  });

  it('prints without a token (the box shows a dash)', async () => {
    const p3 = await fx.newPatient();
    const v = await fx.visit({ patientId: p3, doctorId: fx.doctorA }, IST('2028-05-04T09:00:00'));
    expect(
      await fx.t.app.select().from(opdToken).where(eq(opdToken.encounterId, v.encounterId)),
    ).toHaveLength(0);
    expect(await prepare(OPD_SHEET_TEMPLATE, v.encounterId)).not.toBeNull();
  });
});

describe('patient sticker (REG-07)', () => {
  it('is a 50×25 label with the UHID in the QR and no DUPLICATE mark on reprints', async () => {
    const doc = (await prepare(PATIENT_STICKER_TEMPLATE, patientId, 4))!;
    expect(doc.template.paper).toBe('label50x25');
    expect(doc.meta.docRef).toBe('UH-000123');
    const html = renderPrintHtml(doc, '');
    expect(html).toContain('Radha Devi');
    expect(html).toContain('UH-000123');
    expect(html).toContain('XXXXXX3210');
    expect(html).not.toContain('9876543210');
    expect(html).not.toContain('duplicate-watermark');
    expect(html).not.toContain('<footer');
  });

  it('refuses unknown patients and other facilities', async () => {
    expect(await prepare(PATIENT_STICKER_TEMPLATE, crypto.randomUUID())).toBeNull();
    expect(await prepare(PATIENT_STICKER_TEMPLATE, patientId, 1, crypto.randomUUID())).toBeNull();
    expect(await prepare(PATIENT_STICKER_TEMPLATE, encounterId)).toBeNull();
  });
});

describe('UHID card (REG-07)', () => {
  it('draws front and back at card size with the hospital and the UHID barcode', async () => {
    const doc = (await prepare(UHID_CARD_TEMPLATE, patientId, 3))!;
    expect(doc.meta.docRef).toBe('UH-000123');
    const html = renderPrintHtml(doc, '');
    expect(html).toContain('uhid-card-front');
    expect(html).toContain('uhid-card-back');
    expect(html).toContain('Radha Devi');
    expect(html).toContain('UHID: UH-000123');
    expect(html).toContain('aria-label="UH-000123"'); // barcode
    expect(html).toContain('कृपया हर बार'); // Hindi first
    expect(html).toContain('Please bring this card');
    expect(html).not.toContain('<header'); // the card draws its own
    expect(html).not.toContain('duplicate-watermark');
    expect(html).toContain('width: 85.6mm');
  });
});
