/**
 * BIL-02 receipt on the 80 mm roll, rendered from the database: split payment, masked UPI/card
 * references, amount in words in both languages, DUPLICATE on reprint. Synthetic patients only.
 */
import { addBillLine, collectPayment } from '@hmis/db';
import { patient, service } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { renderPrintHtml } from './render';
import { preparePrintDocument } from './server';
import { RECEIPT_TEMPLATE } from './templates/meta';

let fx: OpdFixture;
let collectionId: string;
let partialId: string;
const at = IST('2028-05-03T10:42:00');

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  const patientId = await fx.newPatient();
  await fx.t.app
    .update(patient)
    .set({ uhid: 'UH-000777', firstName: 'Sita', lastName: 'Kumari', nameHi: 'सीता कुमारी' })
    .where(eq(patient.id, patientId));
  const v = await fx.visit({ patientId }, at);
  const [anc] = await fx.t.app
    .select({ id: service.id })
    .from(service)
    .where(and(eq(service.facilityId, fx.f.facilityId), eq(service.code, 'CONS-ANC')));
  await fx.run((tx) =>
    addBillLine(
      tx,
      fx.actor(),
      { billId: v.billId, serviceId: anc!.id, qty: '2', idempotencyKey: uuidv7() },
      at,
    ),
  );
  const r = await fx.run((tx) =>
    collectPayment(
      tx,
      fx.actor(),
      {
        billId: v.billId,
        tenders: [
          { mode: 'cash', amountPaise: 100_000n },
          { mode: 'upi', amountPaise: 25_000n, upiRef: '123456789012' },
          { mode: 'card', amountPaise: 5_000n, cardLast4: '4242' },
        ],
        idempotencyKey: uuidv7(),
      },
      at,
      { mayFinalize: true },
    ),
  );
  collectionId = r.collectionId;
  const v2 = await fx.visit({ patientId: await fx.newPatient() }, at);
  partialId = (
    await fx.run((tx) =>
      collectPayment(
        tx,
        fx.actor(),
        {
          billId: v2.billId,
          tenders: [{ mode: 'cash', amountPaise: 20_000n }],
          idempotencyKey: uuidv7(),
        },
        at,
        { mayFinalize: true },
      ),
    )
  ).collectionId;
});
afterAll(async () => {
  await fx.t.close();
});

const prepare = (entityId: string, copyNo = 1) =>
  preparePrintDocument({
    db: fx.t.app,
    facilityId: fx.f.facilityId,
    template: RECEIPT_TEMPLATE,
    entityId,
    copyNo,
    printedAt: IST('2028-05-03T10:43:00'),
    printedByName: 'Asha Singh',
  });

describe('payment receipt (BIL-02)', () => {
  it('prints the split payment with masked references and the amount in words', async () => {
    const doc = (await prepare(collectionId))!;
    expect(doc.template.paper).toBe('thermal80');
    expect(doc.meta.docRef).toBe(collectionId);
    const html = renderPrintHtml(doc, '');
    expect(html).toMatch(/RC\/28-29\/\d{6}/);
    expect(html).toMatch(/OB\/28-29\/\d{6}/);
    expect(html).toContain('Sita Kumari');
    expect(html).toContain('सीता कुमारी');
    expect(html).toContain('UH-000777');
    expect(html).toContain('₹1,300.00'); // ₹500 + 2 × ₹400
    expect(html).toContain('₹1,000.00');
    expect(html).toContain('UTR …9012');
    expect(html).not.toContain('123456789012');
    expect(html).toContain('Card …4242');
    expect(html).toContain('एक हज़ार तीन सौ रुपये');
    expect(html).toContain('One thousand three hundred rupees');
    expect(html).toContain('× 2');
    expect(html).toContain('03-May-2028 10:42');
    expect(html).not.toContain('DUPLICATE');
  });

  it('says the bill is still open and shows the balance for a part payment', async () => {
    const html = renderPrintHtml((await prepare(partialId))!, '');
    expect(html).toContain('Advance (bill open)');
    expect(html).toContain('₹300.00'); // balance of ₹500 after ₹200
  });

  it('marks a reprint DUPLICATE and refuses unknown ids', async () => {
    expect(renderPrintHtml((await prepare(collectionId, 2))!, '')).toContain('DUPLICATE');
    expect(await prepare(uuidv7())).toBeNull();
  });
});
