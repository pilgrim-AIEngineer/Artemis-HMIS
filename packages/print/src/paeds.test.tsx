/**
 * OPD-06: the vaccination card, the vaccination certificate and the growth chart rendered from the
 * database. Synthetic children only. Everything printed is also run through the strictest
 * forbidden-term check (AGENTS.md rule 7).
 */
import { recordDose, recordGrowth } from '@hmis/db';
import { patient } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import { findForbiddenTerms, recordDoseSchema, recordGrowthSchema } from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { embeddedFontCss } from './node';
import { renderPrintHtml } from './render';
import { preparePrintDocument } from './server';
import {
  copyFamilyKeys,
  findTemplateMeta,
  GROWTH_CHART_TEMPLATE,
  VACCINATION_CARD_TEMPLATE,
  VACCINATION_CERTIFICATE_TEMPLATE,
} from './templates/meta';

let fx: OpdFixture;
const NOW = IST('2026-10-26T10:00:00');

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

const actor = () => ({ facilityId: fx.f.facilityId, userId: fx.f.userId });

async function child(dob: string, sex: 'F' | 'M' = 'F') {
  const id = await fx.newPatient();
  await fx.t.owner
    .update(patient)
    .set({
      uhid: `UH-${id.slice(-6)}`,
      firstName: 'Aarav',
      lastName: 'Gupta',
      nameHi: 'आरव गुप्ता',
      dob,
      sex,
      mobile: '9876543210',
      guardianName: 'Neha Gupta',
    })
    .where(eq(patient.id, id));
  return id;
}
const dose = (patientId: string, itemCode: string, givenOn: string, over = {}) =>
  fx.run((tx) =>
    recordDose(
      tx,
      actor(),
      recordDoseSchema.parse({
        idempotencyKey: uuidv7(),
        patientId,
        itemCode,
        vaccineName: itemCode,
        batchNo: 'BN-4471',
        expiry: '2027-08-31',
        site: 'left_thigh',
        route: 'im',
        givenOn,
        brand: 'Testvax',
        confirmWarnings: true,
        ...over,
      }),
      NOW,
    ),
  );
const prepare = (template: string, entityId: string) =>
  preparePrintDocument({
    db: fx.t.app,
    facilityId: fx.f.facilityId,
    template,
    entityId,
    copyNo: 1,
    printedAt: NOW,
    printedByName: 'Asha Singh',
  });
const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ');

describe('templates are registered (OPD-06)', () => {
  it('card A5, certificate A4, growth chart A4; all need the paediatrics permission', () => {
    expect(findTemplateMeta(VACCINATION_CARD_TEMPLATE)).toMatchObject({
      paper: 'a5',
      entity: 'patient',
      permission: 'clinical.paeds.edit',
    });
    expect(findTemplateMeta(VACCINATION_CERTIFICATE_TEMPLATE)).toMatchObject({ paper: 'a4' });
    expect(findTemplateMeta(GROWTH_CHART_TEMPLATE)).toMatchObject({ paper: 'a4' });
    expect(copyFamilyKeys(findTemplateMeta(VACCINATION_CARD_TEMPLATE)!)).toEqual([
      VACCINATION_CARD_TEMPLATE,
    ]);
  });
});

describe('vaccination card (docs/11 §4.1)', () => {
  it('prints identity, doses with brand and batch, what is still due and the next date, in both languages', async () => {
    const pid = await child('2026-10-10');
    await dose(pid, 'BCG-1', '2026-10-10', { batchNo: 'BCG-0042', site: 'left_arm', route: 'id' });
    await dose(pid, 'OPV-1', '2026-10-10');
    await dose(pid, 'HEPB-1', '2026-10-10');
    const doc = (await prepare(VACCINATION_CARD_TEMPLATE, pid))!;
    expect(doc.template.paper).toBe('a5');
    const html = renderPrintHtml(doc, embeddedFontCss());
    expect(html).toContain('Aarav Gupta');
    expect(html).toContain('आरव गुप्ता');
    expect(html).toContain('10-Oct-2026');
    expect(html).toContain('XXXXXX3210');
    expect(html).not.toContain('9876543210');
    expect(html).toContain('BCG-0042');
    expect(html).toContain('Testvax');
    expect(html).toContain('31-Aug-2027');
    expect(html).toContain('Left arm');
    expect(html).toContain('टीकाकरण कार्ड');
    expect(html).toContain('Vaccination card');
    // Still to give: the 6-week doses on 21-Nov-2026, the next date in the box.
    expect(html).toMatch(/DTP-1[^<]*<\/span><span class="vax-date">21-Nov-2026/);
    expect(html).toMatch(/data-testid="vax-next"[^>]*><strong>[^<]*<\/strong> 21-Nov-2026/);
    // Already given doses are not in the "still to give" list.
    const pending = /data-testid="vax-pending"[\s\S]*?<\/ul>/.exec(html)![0];
    expect(pending).not.toContain('BCG');
    expect(findForbiddenTerms(textOf(html), { tier: 'strict' })).toEqual([]);
  });

  it('marks overdue doses and says so when nothing was given', async () => {
    const pid = await child('2026-06-01');
    const html = renderPrintHtml(
      (await prepare(VACCINATION_CARD_TEMPLATE, pid))!,
      embeddedFontCss(),
    );
    expect(html).toContain('No vaccine recorded yet.');
    expect(html).toContain('data-overdue="true"');
    expect(html).toContain('Overdue');
  });

  it('is not found for a patient that does not exist or belongs to another facility', async () => {
    expect(await prepare(VACCINATION_CARD_TEMPLATE, uuidv7())).toBeNull();
    const pid = await child('2026-10-10');
    expect(
      await preparePrintDocument({
        db: fx.t.app,
        facilityId: uuidv7(),
        template: VACCINATION_CARD_TEMPLATE,
        entityId: pid,
        copyNo: 1,
        printedAt: NOW,
        printedByName: 'Asha Singh',
      }),
    ).toBeNull();
  });
});

describe('vaccination certificate', () => {
  it('lists the doses given with batches, and room for a signature and stamp', async () => {
    const pid = await child('2026-10-10');
    await dose(pid, 'BCG-1', '2026-10-10', { batchNo: 'BCG-0042' });
    const doc = (await prepare(VACCINATION_CERTIFICATE_TEMPLATE, pid))!;
    expect(doc.template.paper).toBe('a4');
    const html = renderPrintHtml(doc, embeddedFontCss());
    expect(html).toContain('टीकाकरण प्रमाण-पत्र');
    expect(html).toContain('Vaccination certificate');
    expect(html).toContain('BCG-0042');
    expect(html).toContain('Doctor / nurse signature');
    expect(html).not.toContain('data-testid="vax-pending"');
    expect(findForbiddenTerms(textOf(html), { tier: 'strict' })).toEqual([]);
  });
});

describe('growth chart', () => {
  it("draws four charts with the child's points and a table of values and z-scores", async () => {
    const pid = await child('2025-10-26', 'M');
    for (const [on, w, h, hc] of [
      ['2026-04-26', 8.1, 68, 44.5],
      ['2026-10-26', 9.9, 76, 46.5],
    ] as const) {
      await fx.run((tx) =>
        recordGrowth(
          tx,
          actor(),
          recordGrowthSchema.parse({
            idempotencyKey: uuidv7(),
            patientId: pid,
            measuredOn: on,
            weightKg: w,
            lengthHeightCm: h,
            headCircCm: hc,
          }),
          NOW,
        ),
      );
    }
    const doc = (await prepare(GROWTH_CHART_TEMPLATE, pid))!;
    expect(doc.template.paper).toBe('a4');
    const html = renderPrintHtml(doc, embeddedFontCss());
    expect((html.match(/data-testid="growth-chart-/g) ?? []).length).toBe(4);
    expect((html.match(/data-testid="growth-point"/g) ?? []).length).toBe(8);
    for (const t of [
      'Weight for age (kg)',
      'Head circumference for age (cm)',
      'वृद्धि चार्ट (डब्ल्यूएचओ)',
    ]) {
      expect(html, t).toContain(t);
    }
    expect(html).toContain('26-Apr-2026');
    expect(html).toContain('9.9');
    expect(findForbiddenTerms(textOf(html), { tier: 'strict' })).toEqual([]);
  });

  it('prints values only, with the reason, at 5 years and over', async () => {
    const pid = await child('2019-01-01');
    await fx.run((tx) =>
      recordGrowth(
        tx,
        actor(),
        recordGrowthSchema.parse({
          idempotencyKey: uuidv7(),
          patientId: pid,
          measuredOn: '2026-10-26',
          weightKg: 22,
          lengthHeightCm: 118,
          headCircCm: null,
        }),
        NOW,
      ),
    );
    const html = renderPrintHtml((await prepare(GROWTH_CHART_TEMPLATE, pid))!, embeddedFontCss());
    expect(html).not.toContain('data-testid="growth-chart-');
    expect(html).toContain('Values only');
    expect(html).toContain('118');
  });
});
