/**
 * BIL-02 receipt on the 80 mm roll, rendered from the database: split payment, masked UPI/card
 * references, amount in words in both languages, DUPLICATE on reprint. Synthetic patients only.
 */
import {
  addBillLine,
  nextCopyNo,
  recordPrint,
  cancelFinalBill,
  collectPayment,
  ensureFacilityRbac,
  grantRoles,
  withTx,
} from '@hmis/db';
import { patient, reasonCode, service } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { renderPrintHtml } from './render';
import { receiptStamp } from './templates/receipt';
import { preparePrintDocument } from './server';
import {
  copyFamilyKeys,
  findTemplateMeta,
  RECEIPT_A5_TEMPLATE,
  RECEIPT_TEMPLATE,
} from './templates/meta';

let fx: OpdFixture;
let collectionId: string;
let partialId: string;
let cancelledPaymentId: string;
let refundId: string;
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

  // A paid bill cancelled by the owner: its receipt shows BILL CANCELLED, the refund is a voucher.
  await withTx({ db: fx.t.owner, userId: null }, async (tx) => {
    await ensureFacilityRbac(tx, fx.f.facilityId);
    await grantRoles(tx, fx.f.facilityId, fx.f.userId, ['owner']);
  });
  const v3 = await fx.visit({ patientId: await fx.newPatient() }, at);
  cancelledPaymentId = (
    await fx.run((tx) =>
      collectPayment(
        tx,
        fx.actor(),
        {
          billId: v3.billId,
          tenders: [{ mode: 'cash', amountPaise: 50_000n }],
          idempotencyKey: uuidv7(),
        },
        at,
        { mayFinalize: true },
      ),
    )
  ).collectionId;
  const [reason] = await fx.t.app
    .select({ id: reasonCode.id })
    .from(reasonCode)
    .where(and(eq(reasonCode.facilityId, fx.f.facilityId), eq(reasonCode.code, 'patient_request')));
  const cancelled = await fx.run((tx) =>
    cancelFinalBill(
      tx,
      fx.actor(),
      {
        billId: v3.billId,
        reasonCodeId: reason!.id,
        refund: { mode: 'cash' },
        idempotencyKey: uuidv7(),
      },
      at,
      { approverId: null },
    ),
  );
  refundId = cancelled.refundCollectionId!;
});
afterAll(async () => {
  await fx.t.close();
});

const prepare = (entityId: string, copyNo = 1, template: string = RECEIPT_TEMPLATE) =>
  preparePrintDocument({
    db: fx.t.app,
    facilityId: fx.f.facilityId,
    template,
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

describe('refund voucher and cancelled bill (BIL-04)', () => {
  it('prints the refund as money handed back, with the credit note number', async () => {
    const html = renderPrintHtml((await prepare(refundId))!, '');
    expect(html).toContain('Refund / Credit note');
    expect(html).toMatch(/CN\/28-29\/\d{5}/);
    expect(html).toContain('Amount refunded');
    expect(html).toContain('₹500.00');
    expect(html).not.toContain('-₹');
    expect(html).toContain('पाँच सौ रुपये');
    expect(html).toContain('Five hundred rupees');
    expect(html).not.toContain('Amount received');
  });

  it('marks the original receipt of a cancelled bill', async () => {
    const html = renderPrintHtml((await prepare(cancelledPaymentId))!, '');
    expect(html).toContain('BILL CANCELLED');
    expect(html).toContain('Amount received');
    expect(renderPrintHtml((await prepare(collectionId))!, '')).not.toContain('BILL CANCELLED');
  });
});

describe('receipt on A5 (BIL-05)', () => {
  const prepareA5 = (id: string, copyNo = 1) => prepare(id, copyNo, RECEIPT_A5_TEMPLATE);

  it('is the same receipt, itemised with quantity and rate on A5 paper', async () => {
    const doc = (await prepareA5(collectionId))!;
    expect(doc.template.paper).toBe('a5');
    expect(doc.template.markDuplicate).toBeUndefined();
    const html = renderPrintHtml(doc, '');
    expect(html).toContain('print-paper-a5');
    expect(html).toContain('data-testid="receipt-items"');
    expect(html).toMatch(/RC\/28-29\/\d{6}/);
    expect(html).toContain('Sita Kumari');
    expect(html).toContain('सीता कुमारी');
    expect(html).toContain('UH-000777');
    expect(html).toContain('Qty');
    expect(html).toContain('मात्रा');
    expect(html).toContain('₹400.00'); // the ANC rate
    expect(html).toContain('₹800.00'); // 2 × ANC
    expect(html).toContain('₹1,300.00');
    expect(html).toContain('UTR …9012');
    expect(html).not.toContain('123456789012');
    expect(html).toContain('Card …4242');
    expect(html).toContain('One thousand three hundred rupees');
    expect(html).toContain('Receiver signature');
    expect(html).not.toContain('DUPLICATE');
    expect(html).not.toContain('status-watermark');
  });

  it('marks a reprint DUPLICATE with the copy number', async () => {
    const html = renderPrintHtml((await prepareA5(collectionId, 3))!, '');
    expect(html).toContain('data-testid="duplicate-watermark"');
    expect(html).toContain('DUPLICATE');
    expect(html).toContain('#3');
  });

  it('draws the CANCELLED mark on a reversed receipt and BILL CANCELLED on a cancelled bill', async () => {
    const bill = renderPrintHtml((await prepareA5(cancelledPaymentId))!, '');
    expect(bill).toContain('data-testid="status-watermark"');
    expect(bill).toContain('BILL CANCELLED');
    // …on the roll as well, and together with DUPLICATE on a reprint
    const roll = renderPrintHtml((await prepare(cancelledPaymentId, 2))!, '');
    expect(roll).toContain('data-testid="status-watermark"');
    expect(roll).toContain('data-testid="duplicate-watermark"');
    expect(renderPrintHtml((await prepareA5(refundId))!, '')).not.toContain('status-watermark');
  });

  it('a reversed payment prints CANCELLED across the page', async () => {
    // Payment reversal itself arrives with a later PR; the mark follows `status = reversed`.
    const doc = (await prepareA5(partialId))!;
    expect(doc.stamp).toBeNull();
    const reversed = receiptStamp({ status: 'reversed', kind: 'payment', bill: null } as never);
    expect(reversed).toEqual({ hi: 'रद्द', en: 'CANCELLED' });
    const html = renderPrintHtml({ ...doc, stamp: reversed }, '');
    expect(html).toContain('data-testid="status-watermark"');
    expect(html).toContain('CANCELLED');
  });

  it('thermal and A5 are one document: they share the copy counter', async () => {
    const target = {
      facilityId: fx.f.facilityId,
      entityId: collectionId,
      family: copyFamilyKeys(findTemplateMeta(RECEIPT_TEMPLATE)!),
    };
    expect(target.family.sort()).toEqual([RECEIPT_A5_TEMPLATE, RECEIPT_TEMPLATE].sort());
    expect(await nextCopyNo(fx.t.app, { ...target, template: RECEIPT_A5_TEMPLATE })).toBe(1);
    const first = await fx.run((tx) =>
      recordPrint(tx, {
        ...target,
        template: RECEIPT_TEMPLATE,
        entity: 'receipt',
        userId: fx.f.userId,
      }),
    );
    expect(first.copyNo).toBe(1);
    // The A5 print of an already printed receipt is copy 2, i.e. a DUPLICATE.
    expect(await nextCopyNo(fx.t.app, { ...target, template: RECEIPT_A5_TEMPLATE })).toBe(2);
    const second = await fx.run((tx) =>
      recordPrint(tx, {
        ...target,
        template: RECEIPT_A5_TEMPLATE,
        entity: 'receipt',
        userId: fx.f.userId,
      }),
    );
    expect(second.copyNo).toBe(2);
    expect(await nextCopyNo(fx.t.app, { ...target, template: RECEIPT_TEMPLATE })).toBe(3);
    // Other documents are not affected.
    expect(
      await nextCopyNo(fx.t.app, { ...target, entityId: partialId, template: RECEIPT_TEMPLATE }),
    ).toBe(1);
  });
});
