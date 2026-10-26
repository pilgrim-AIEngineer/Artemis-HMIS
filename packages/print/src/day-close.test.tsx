/**
 * BIL-06 prints: the cashier's close slip (80 mm) and the owner's facility summary (A4), drawn from
 * real closes. Synthetic data only.
 */
import { closeFacilityDay, closeOwnDay, collectPayment } from '@hmis/db';
import { dayClose } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { renderPrintHtml } from './render';
import { preparePrintDocument } from './server';
import { DAY_CLOSE_TEMPLATE, FACILITY_CLOSE_TEMPLATE } from './templates/meta';

let fx: OpdFixture;
let userCloseId: string;
let facilityCloseId: string;
const at = IST('2028-05-03T19:00:00');
const DEN = { n500: 1, n200: 0, n100: 0, n50: 1, n20: 0, n10: 0, coinsPaise: 0 };

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  for (const tenders of [
    [{ mode: 'cash' as const, amountPaise: 50_000n }],
    [{ mode: 'upi' as const, amountPaise: 50_000n, upiRef: '4321' }],
  ]) {
    const v = await fx.visit({ patientId: await fx.newPatient() }, at);
    await fx.run((tx) =>
      collectPayment(tx, fx.actor(), { billId: v.billId, tenders, idempotencyKey: uuidv7() }, at, {
        mayFinalize: true,
      }),
    );
  }
  userCloseId = (
    await fx.run((tx) =>
      closeOwnDay(
        tx,
        fx.actor(),
        {
          denominations: DEN,
          expectedCashPaise: '50000',
          differenceReason: 'Rs 50 extra, patient left it',
          idempotencyKey: uuidv7(),
        },
        at,
      ),
    )
  ).dayCloseId;
  facilityCloseId = (
    await fx.run((tx) =>
      closeFacilityDay(
        tx,
        fx.actor(),
        { closeDate: '2028-05-03', idempotencyKey: uuidv7() },
        IST('2028-05-03T20:00:00'),
      ),
    )
  ).dayCloseId;
});
afterAll(async () => {
  await fx.t.close();
});

const prepare = (template: string, entityId: string, copyNo = 1) =>
  preparePrintDocument({
    db: fx.t.app,
    facilityId: fx.f.facilityId,
    template,
    entityId,
    copyNo,
    printedAt: IST('2028-05-03T20:05:00'),
    printedByName: 'Asha Singh',
  });

describe('cashier close slip (80 mm)', () => {
  it('shows expected by mode, the denomination count, the variance and its reason', async () => {
    const doc = (await prepare(DAY_CLOSE_TEMPLATE, userCloseId))!;
    expect(doc.template.paper).toBe('thermal80');
    const html = renderPrintHtml(doc, '');
    expect(html).toContain('03-May-2028');
    expect(html).toContain('Day close');
    expect(html).toContain('दिन का समापन');
    expect(html).toContain('₹500'); // note rows
    expect(html).toContain('₹50<'); // 1 × ₹50
    expect(html).toContain('₹550.00'); // counted
    expect(html).toContain('+₹50.00'); // over by ₹50
    expect(html).toContain('(Over)');
    expect(html).toContain('Rs 50 extra, patient left it');
    expect(html).toContain('₹1,000.00'); // cash 500 + UPI 500 collected
    expect(html).not.toContain('DUPLICATE');
  });

  it('is a DUPLICATE on reprint, and a facility close id is not a user slip', async () => {
    expect(renderPrintHtml((await prepare(DAY_CLOSE_TEMPLATE, userCloseId, 2))!, '')).toContain(
      'DUPLICATE',
    );
    expect(await prepare(DAY_CLOSE_TEMPLATE, facilityCloseId)).toBeNull();
    expect(await prepare(DAY_CLOSE_TEMPLATE, uuidv7())).toBeNull();
  });
});

describe('facility summary (A4)', () => {
  it('lists the counters, totals by mode, department and doctor, and the UPI status', async () => {
    const doc = (await prepare(FACILITY_CLOSE_TEMPLATE, facilityCloseId))!;
    expect(doc.template.paper).toBe('a4');
    const html = renderPrintHtml(doc, '');
    expect(html).toContain('Facility day-close summary');
    expect(html).toContain('03-May-2028');
    expect(html).toContain('data-testid="facility-close-users"');
    expect(html).toContain('Rs 50 extra, patient left it');
    expect(html).toContain('+₹50.00');
    expect(html).toContain('₹1,000.00');
    expect(html).toContain('Dr. A');
    expect(html).toContain('Not started');
    expect(html).not.toContain('Counters not closed');
  });

  it('refuses a user close id', async () => {
    expect(await prepare(FACILITY_CLOSE_TEMPLATE, userCloseId)).toBeNull();
  });

  it('keeps the facility close row as the one for the day', async () => {
    const rows = await fx.t.app
      .select()
      .from(dayClose)
      .where(and(eq(dayClose.facilityId, fx.f.facilityId), eq(dayClose.kind, 'facility')));
    expect(rows).toHaveLength(1);
  });
});
