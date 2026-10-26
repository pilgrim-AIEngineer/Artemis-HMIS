/**
 * OPD-05: the antenatal card rendered from the database. Synthetic patients only. Everything the
 * card prints is also run through the strictest forbidden-term check (AGENTS.md rule 7).
 */
import {
  closePregnancy,
  createPregnancy,
  saveAncVisit,
  markScheduleItem,
  updatePregnancy,
} from '@hmis/db';
import { patient } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import {
  closePregnancySchema,
  createPregnancySchema,
  findForbiddenTerms,
  markScheduleSchema,
  saveAncVisitSchema,
  updatePregnancySchema,
} from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { renderPrintHtml } from './render';
import { preparePrintDocument } from './server';
import {
  ANC_CARD_TEMPLATE,
  copyFamilyKeys,
  findTemplateMeta,
  OPD_SHEET_TEMPLATE,
} from './templates/meta';
import { embeddedFontCss } from './node';

let fx: OpdFixture;
const NOW = IST('2026-10-26T10:00:00');

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

const actor = (mtp = { view: false, edit: false }) => ({
  facilityId: fx.f.facilityId,
  userId: fx.f.userId,
  mtp,
});

async function pregnancyFor(lmp = '2026-07-20') {
  const patientId = await fx.newPatient();
  await fx.t.owner
    .update(patient)
    .set({
      uhid: `UH-${patientId.slice(-6)}`,
      firstName: 'Sunita',
      lastName: 'Verma',
      nameHi: 'सुनीता वर्मा',
      dob: '1998-05-05',
      mobile: '9876543210',
      guardianName: 'Ramesh Verma',
    })
    .where(eq(patient.id, patientId));
  const { pregnancyId } = await fx.run((tx) =>
    createPregnancy(
      tx,
      actor(),
      createPregnancySchema.parse({
        patientId,
        idempotencyKey: uuidv7(),
        lmp,
        bloodGroupRh: 'O-',
      }),
      NOW,
    ),
  );
  return { patientId, pregnancyId };
}

const prepare = (entityId: string, facilityId = fx.f.facilityId) =>
  preparePrintDocument({
    db: fx.t.app,
    facilityId,
    template: ANC_CARD_TEMPLATE,
    entityId,
    copyNo: 1,
    printedAt: NOW,
    printedByName: 'Asha Singh',
  });

describe('ANC card (OPD-05, docs/11 §3.5)', () => {
  it('is an A5 template that needs the ANC permission', () => {
    const m = findTemplateMeta(ANC_CARD_TEMPLATE)!;
    expect(m).toMatchObject({ paper: 'a5', entity: 'pregnancy', permission: 'clinical.anc.edit' });
    expect(copyFamilyKeys(m)).toEqual([ANC_CARD_TEMPLATE]);
  });

  it('prints booking details, EDD, blood group, risks, visits, tests and next visit in both languages', async () => {
    const { pregnancyId } = await pregnancyFor();
    await fx.run(async (tx) => {
      await updatePregnancy(
        tx,
        actor(),
        updatePregnancySchema.parse({
          pregnancyId,
          bloodGroupRh: 'O-',
          plurality: 'single',
          manualRisks: [{ code: 'gdm' }, { code: 'other', text: 'Epilepsy on treatment' }],
          notes: null,
        }),
        NOW,
      );
      await saveAncVisit(
        tx,
        actor(),
        saveAncVisitSchema.parse({
          pregnancyId,
          visitDate: '2026-10-26',
          weightKg: 58.5,
          bpSys: 152,
          bpDia: 98,
          fundalHeightCm: 14,
          fhr: 148,
          presentation: 'cephalic',
          oedema: 'plus1',
          urineProtein: 'trace',
          urineSugar: 'nil',
          hb: 10.4,
          remarks: 'Fe tablets given',
        }),
        NOW,
      );
      await markScheduleItem(
        tx,
        actor(),
        markScheduleSchema.parse({
          pregnancyId,
          code: 'td_1',
          status: 'done',
          doneDate: '2026-10-26',
        }),
        NOW,
      );
    });
    const doc = (await prepare(pregnancyId))!;
    expect(doc.template.paper).toBe('a5');
    expect(doc.meta.docRef).toBe(pregnancyId);
    const html = renderPrintHtml(doc, embeddedFontCss());

    // Booking block
    expect(html).toContain('Sunita Verma');
    expect(html).toContain('सुनीता वर्मा');
    expect(html).toContain('20-Jul-2026'); // LMP
    expect(html).toContain('26-Apr-2027'); // EDD
    expect(html).toContain('14w 0d');
    expect(html).toContain('G1 P0 A0 L0');
    expect(html).toContain('O-');
    // XXXXXX plus last four of the mobile only
    expect(html).toContain('XXXXXX3210');
    expect(html).not.toContain('9876543210');
    // Risk flags: auto (BP, Hb, Rh) and manual, Hindi and English
    for (const t of [
      'Raised BP',
      'उच्च रक्तचाप',
      'Anaemia',
      'खून की कमी',
      'Rh negative',
      'Gestational diabetes',
      'Epilepsy on treatment',
    ]) {
      expect(html, t).toContain(t);
    }
    // Visit row
    expect(html).toContain('152/98');
    expect(html).toContain('58.5');
    expect(html).toContain('Ceph');
    expect(html).toContain('Fe tablets given');
    // Schedule with Td-1 done, next visit
    expect(html).toMatch(/Td-1[^<]*<\/span><span class="anc-state">Done 26-Oct-2026/);
    expect(html).toContain('Anomaly scan');
    expect(html).toContain('23-Nov-2026'); // 28 days after a visit at 14w0d
    // Bilingual headings
    expect(html).toContain('गर्भावस्था जाँच कार्ड');
    expect(html).toContain('Antenatal care card');

    // Nothing printed trips the forbidden-term check, in either tier.
    const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
    expect(findForbiddenTerms(text, { tier: 'strict' })).toEqual([]);
  });

  it('a card with no visits says so, and a woman with no risk says none', async () => {
    const { pregnancyId } = await pregnancyFor('2026-09-15');
    await fx.run((tx) =>
      updatePregnancy(
        tx,
        actor(),
        updatePregnancySchema.parse({
          pregnancyId,
          bloodGroupRh: 'B+',
          plurality: 'single',
          manualRisks: [],
          notes: null,
        }),
        NOW,
      ),
    );
    const html = renderPrintHtml((await prepare(pregnancyId))!, embeddedFontCss());
    expect(html).toContain('No visits recorded yet');
    expect(html).toContain('कोई नहीं / None');
  });

  it('is not found for another facility, an unknown id, and a pregnancy closed as MTP', async () => {
    const { pregnancyId } = await pregnancyFor();
    expect(await prepare(pregnancyId, uuidv7())).toBeNull();
    expect(await prepare(uuidv7())).toBeNull();
    await fx.run((tx) =>
      closePregnancy(
        tx,
        actor({ view: true, edit: true }),
        closePregnancySchema.parse({ pregnancyId, outcome: 'mtp', outcomeDate: '2026-10-26' }),
        NOW,
      ),
    );
    expect(await prepare(pregnancyId)).toBeNull();
  });

  it('still prints after a normal delivery, with the final record', async () => {
    const { pregnancyId } = await pregnancyFor('2026-01-25');
    await fx.run((tx) =>
      closePregnancy(
        tx,
        actor(),
        closePregnancySchema.parse({
          pregnancyId,
          outcome: 'delivered',
          outcomeDate: '2026-10-26',
          obOutcome: 'nvd',
        }),
        NOW,
      ),
    );
    const doc = await prepare(pregnancyId);
    expect(doc).not.toBeNull();
  });
});

describe('OPD sheet pregnancy block (docs/10 §8)', () => {
  it('shows GA, EDD, G P A L, risks in bold, last visits and tests due for a pregnant woman only', async () => {
    const { patientId, pregnancyId } = await pregnancyFor();
    await fx.run((tx) =>
      saveAncVisit(
        tx,
        actor(),
        saveAncVisitSchema.parse({
          pregnancyId,
          visitDate: '2026-10-26',
          bpSys: 150,
          bpDia: 96,
          weightKg: 60,
        }),
        NOW,
      ),
    );
    const v = await fx.visit({ patientId, doctorId: fx.doctorA }, NOW);
    const doc = (await preparePrintDocument({
      db: fx.t.app,
      facilityId: fx.f.facilityId,
      template: OPD_SHEET_TEMPLATE,
      entityId: v.encounterId,
      copyNo: 1,
      printedAt: NOW,
      printedByName: 'Asha Singh',
    }))!;
    const html = renderPrintHtml(doc, embeddedFontCss());
    expect(html).toContain('data-testid="sheet-pregnancy"');
    expect(html).toContain('14w 0d');
    expect(html).toContain('26-Apr-2027');
    expect(html).toContain('G1 P0 A0 L0');
    expect(html).toContain('Raised BP');
    expect(html).toContain('26-Oct-2026 150/96 60kg');
    expect(html).toContain('Td: due');

    const other = await fx.newPatient();
    const v2 = await fx.visit({ patientId: other, doctorId: fx.doctorA }, NOW);
    const plain = (await preparePrintDocument({
      db: fx.t.app,
      facilityId: fx.f.facilityId,
      template: OPD_SHEET_TEMPLATE,
      entityId: v2.encounterId,
      copyNo: 1,
      printedAt: NOW,
      printedByName: 'Asha Singh',
    }))!;
    expect(renderPrintHtml(plain, embeddedFontCss())).not.toContain('sheet-pregnancy');
  });
});
