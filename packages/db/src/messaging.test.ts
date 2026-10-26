import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { messageOutbox, messageTemplate, patient, patientConsent } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { collectPayment } from './billing';
import {
  cancelQueuedMessages,
  claimDueMessages,
  deferMessage,
  enqueueMessage,
  ensureMessageTemplates,
  markAttemptFailed,
  markSent,
  setTemplatesApproved,
  type EnqueueInput,
} from './messaging';
import { writeSetting } from './settings';

let fx: OpdFixture;
const NOW = IST('2026-10-26T11:00:00');
const hours = (n: number) => n * 3_600_000;

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
});
afterAll(async () => {
  await fx.t.close();
});

const consent = (patientId: string, granted: boolean, at = NOW) =>
  fx.run((tx) =>
    tx.insert(patientConsent).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      patientId,
      kind: 'whatsapp',
      granted,
      at,
      method: 'verbal_recorded',
    }),
  );

const input = (patientId: string, over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  facilityId: fx.f.facilityId,
  patientId,
  kind: 'follow_up',
  entityId: uuidv7(),
  variables: { patientName: 'Test', doctorName: 'Dr A', date: '27-Oct-2026' },
  ...over,
});
const enqueue = (i: EnqueueInput, at = NOW) => fx.run((tx) => enqueueMessage(tx, i, at));
const rows = (patientId: string) =>
  fx.t.app.select().from(messageOutbox).where(eq(messageOutbox.patientId, patientId));
const row = async (id: string) =>
  (await fx.t.app.select().from(messageOutbox).where(eq(messageOutbox.id, id)))[0]!;

describe('queueing (MSG-01)', () => {
  it('queues for a patient with consent, with the mobile in WhatsApp form', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const r = await enqueue(input(pid));
    expect(r.skipped).toBeNull();
    expect(await row(r.id!)).toMatchObject({
      status: 'queued',
      toMobile: '919876500000',
      attempts: 0,
      language: 'hi',
    });
  });

  it('keeps a skipped_no_consent record and sends nothing without an active grant (D-9)', async () => {
    const none = await fx.newPatient();
    expect((await enqueue(input(none))).skipped).toBe('no_consent');
    const withdrawn = await fx.newPatient();
    await consent(withdrawn, true, new Date(NOW.getTime() - 1000));
    await consent(withdrawn, false, NOW);
    expect((await enqueue(input(withdrawn))).skipped).toBe('no_consent');
    for (const pid of [none, withdrawn]) {
      expect((await rows(pid)).map((r) => r.status)).toEqual(['skipped_no_consent']);
    }
    // Asking again for the same message does not pile up records.
    const entityId = uuidv7();
    await enqueue(input(none, { entityId }));
    await enqueue(input(none, { entityId }));
    expect((await rows(none)).filter((r) => r.entityId === entityId)).toHaveLength(1);
  });

  it('does nothing while WhatsApp is switched off, for restricted encounters and without a mobile', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', false));
    expect((await enqueue(input(pid))).skipped).toBe('disabled');
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
    expect((await enqueue(input(pid, { restricted: true }))).skipped).toBe('restricted');
    await fx.t.owner
      .update(patient)
      .set({ mobile: null, noMobileReason: 'no_phone' })
      .where(eq(patient.id, pid));
    expect((await enqueue(input(pid))).skipped).toBe('no_mobile');
    expect(await rows(pid)).toHaveLength(0);
  });

  it('skips the same template for the same patient and entity within 24 h, not after', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    // created_at is the database clock, so this one runs on the real one.
    const t0 = new Date();
    const i = input(pid);
    expect((await enqueue(i, t0)).skipped).toBeNull();
    expect((await enqueue(i, new Date(t0.getTime() + hours(23)))).skipped).toBe('duplicate');
    // A different entity is a different message.
    expect((await enqueue(input(pid), t0)).skipped).toBeNull();
    // After 24 h and a finished first message, the same entity may be sent again.
    await fx.t.owner
      .update(messageOutbox)
      .set({ status: 'sent' })
      .where(and(eq(messageOutbox.patientId, pid), eq(messageOutbox.entityId, i.entityId)));
    expect((await enqueue(i, new Date(t0.getTime() + hours(25)))).skipped).toBeNull();
  });

  it('moves reminders out of quiet hours (9 pm – 8 am) but not receipts', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const night = IST('2026-10-26T22:30:00');
    const early = IST('2026-10-27T05:00:00');
    const a = await enqueue(input(pid, { sendAfter: night }), night);
    expect((await row(a.id!)).sendAfter).toEqual(IST('2026-10-27T08:00:00'));
    const b = await enqueue(input(pid, { sendAfter: early }), early);
    expect((await row(b.id!)).sendAfter).toEqual(IST('2026-10-27T08:00:00'));
    const c = await enqueue(
      input(pid, { kind: 'receipt', variables: { amount: '₹1.00' }, sendAfter: night }),
      night,
    );
    expect((await row(c.id!)).sendAfter).toEqual(night);
  });

  it('opt-out stops what is still queued', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const a = await enqueue(input(pid));
    const n = await fx.run((tx) => cancelQueuedMessages(tx, fx.f.facilityId, pid, 'stop_reply'));
    expect(n).toBe(1);
    expect(await row(a.id!)).toMatchObject({ status: 'opted_out', cancelReason: 'stop_reply' });
  });
});

describe('claiming and results', () => {
  const claim = (at: Date, limit?: number) =>
    claimDueMessages(fx.t.app, fx.f.facilityId, at, limit);

  it('claims a due row once, counts the attempt and does not hand it out twice', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const a = await enqueue(input(pid, { kind: 'receipt', variables: {} }));
    const [one, two] = await Promise.all([claim(NOW), claim(NOW)]);
    const mine = [...one.messages, ...two.messages].filter((m) => m.id === a.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ attempts: 1 });
    expect(await row(a.id!)).toMatchObject({ status: 'sending', attempts: 1 });
    await markSent(fx.t.app, mine[0]!, 'wamid.1', NOW);
    expect(await row(a.id!)).toMatchObject({ status: 'sent', providerMessageId: 'wamid.1' });
  });

  it('does not claim rows that are not due yet', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const later = new Date(NOW.getTime() + hours(5));
    const a = await enqueue(input(pid, { kind: 'receipt', variables: {}, sendAfter: later }));
    expect((await claim(NOW)).messages.map((m) => m.id)).not.toContain(a.id);
    expect((await claim(later)).messages.map((m) => m.id)).toContain(a.id);
  });

  it('retries with growing delays for 48 h, then fails; permanent errors fail at once', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const a = await enqueue(input(pid, { kind: 'receipt', variables: {} }));
    let at = NOW;
    let m = (await claim(at)).messages.find((x) => x.id === a.id)!;
    const delays: number[] = [];
    let state: 'queued' | 'failed' = 'queued';
    while (state === 'queued') {
      state = await markAttemptFailed(fx.t.app, m, { message: 'meta:503', retryable: true }, at);
      if (state === 'failed') break;
      const r = await row(a.id!);
      expect(r).toMatchObject({ status: 'queued', lastError: 'meta:503' });
      delays.push(r.sendAfter.getTime() - at.getTime());
      at = r.sendAfter;
      m = (await claim(at)).messages.find((x) => x.id === a.id)!;
    }
    expect(delays.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(Math.max(...delays)).toBe(hours(2));
    const last = await row(a.id!);
    expect(last).toMatchObject({ status: 'failed', lastError: 'meta:503' });
    expect(at.getTime() - NOW.getTime()).toBeGreaterThan(hours(45));
    expect(at.getTime() - NOW.getTime()).toBeLessThanOrEqual(hours(48));

    const b = await enqueue(input(pid, { kind: 'receipt', variables: {} }));
    const mb = (await claim(NOW)).messages.find((x) => x.id === b.id)!;
    expect(
      await markAttemptFailed(fx.t.app, mb, { message: 'meta:400:131026', retryable: false }, NOW),
    ).toBe('failed');
  });

  it('puts an abandoned claim back after 15 minutes', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const a = await enqueue(input(pid, { kind: 'receipt', variables: {} }));
    await claim(NOW);
    expect(
      (await claim(new Date(NOW.getTime() + 5 * 60_000))).messages.map((m) => m.id),
    ).not.toContain(a.id);
    expect(
      (await claim(new Date(NOW.getTime() + 16 * 60_000))).messages.map((m) => m.id),
    ).toContain(a.id);
  });

  it('a deferred row does not use up an attempt', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const a = await enqueue(input(pid, { kind: 'receipt', variables: {} }));
    const m = (await claim(NOW)).messages.find((x) => x.id === a.id)!;
    await deferMessage(fx.t.app, m, 'template_not_approved', new Date(NOW.getTime() + 60_000));
    expect(await row(a.id!)).toMatchObject({
      status: 'queued',
      attempts: 0,
      firstAttemptAt: null,
      lastError: 'template_not_approved',
    });
  });

  it('stops claiming at the monthly cap', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const sentBefore = (await fx.t.app.select().from(messageOutbox)).filter((r) => r.sentAt);
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'whatsapp.monthlyCap', sentBefore.length),
    );
    const a = await enqueue(input(pid, { kind: 'receipt', variables: {} }));
    const r = await claim(NOW);
    expect(r.messages).toHaveLength(0);
    expect(r.usage.cap).toBe(sentBefore.length);
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.monthlyCap', 0));
    expect((await claim(NOW)).messages.map((m) => m.id)).toContain(a.id);
  });
});

describe('templates', () => {
  it('seeds en and hi rows for every kind, unapproved, once', async () => {
    const n = await fx.run((tx) => ensureMessageTemplates(tx, fx.f.facilityId));
    expect(n).toBe(8);
    expect(await fx.run((tx) => ensureMessageTemplates(tx, fx.f.facilityId))).toBe(0);
    const all = await fx.t.app.select().from(messageTemplate);
    expect(all.every((t) => !t.isApproved)).toBe(true);
  });

  it('approval is recorded per kind', async () => {
    await fx.run((tx) => setTemplatesApproved(tx, fx.f.facilityId, true, 'receipt'));
    const all = await fx.t.app
      .select()
      .from(messageTemplate)
      .where(eq(messageTemplate.facilityId, fx.f.facilityId));
    expect(all).toHaveLength(8);
    expect(
      all
        .filter((t) => t.isApproved)
        .map((t) => t.providerTemplateName)
        .sort(),
    ).toEqual(['hmis_receipt_en', 'hmis_receipt_hi']);
  });
});

describe('receipt message on payment (docs/21 §3)', () => {
  const pay = async (patientId: string, key = uuidv7()) => {
    const v = await fx.visit({ patientId }, NOW);
    const out = await fx.run((tx) =>
      collectPayment(
        tx,
        { ...fx.actor(), workstationId: fx.f.workstationId },
        {
          billId: v.billId,
          tenders: [{ mode: 'cash', amountPaise: 50_000n }],
          idempotencyKey: key,
        },
        NOW,
        { mayFinalize: true },
      ),
    );
    return out;
  };

  it('queues a receipt only when the setting is on and the patient agreed', async () => {
    const off = await fx.newPatient();
    await consent(off, true);
    await pay(off);
    expect(await rows(off)).toHaveLength(0);

    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.sendReceipts', true));
    const on = await fx.newPatient();
    await consent(on, true);
    const first = await pay(on);
    const [msg] = await rows(on);
    expect(msg).toMatchObject({
      templateKind: 'receipt',
      status: 'queued',
      entityId: first.collectionId,
    });
    expect(msg!.variables).toMatchObject({ amount: '₹500.00', receiptNo: first.receiptNumber });

    const noConsent = await fx.newPatient();
    await pay(noConsent);
    expect((await rows(noConsent)).map((r) => r.status)).toEqual(['skipped_no_consent']);
  });

  it('a replayed payment (same idempotency key) does not queue a second message', async () => {
    const pid = await fx.newPatient();
    await consent(pid, true);
    const v = await fx.visit({ patientId: pid }, NOW);
    const key = uuidv7();
    const go = () =>
      fx.run((tx) =>
        collectPayment(
          tx,
          { ...fx.actor(), workstationId: fx.f.workstationId },
          {
            billId: v.billId,
            tenders: [{ mode: 'cash', amountPaise: 50_000n }],
            idempotencyKey: key,
          },
          NOW,
          { mayFinalize: true },
        ),
      );
    await go();
    await go();
    expect((await rows(pid)).filter((r) => r.templateKind === 'receipt')).toHaveLength(1);
  });
});
