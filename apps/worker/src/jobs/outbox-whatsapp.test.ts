import { enqueueMessage, setTemplatesApproved, writeSetting, type EnqueueInput } from '@hmis/db';
import { messageOutbox, patientConsent } from '@hmis/db/schema';
import { IST, setupOpdFixture, type OpdFixture } from '@hmis/db/testing/opd';
import { createLogger } from '@hmis/shared/logger';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { FakeProvider } from '../messaging/fake';
import { JOBS } from './index';
import { OUTBOX_WHATSAPP_QUEUE, processOutbox } from './outbox-whatsapp';
import { REMINDER_DAILY_QUEUE } from './reminder-daily';

let fx: OpdFixture;
const NOW = IST('2026-10-26T11:00:00');
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;
const logger = createLogger('test');

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
});
afterAll(async () => {
  await fx.t.close();
});

const drain = (provider: FakeProvider, at: Date) =>
  processOutbox({
    db: fx.t.app,
    filesDir: '/nonexistent',
    logger,
    providerFor: () => provider,
    now: () => at,
  });

async function queued(over: Partial<EnqueueInput> = {}) {
  const patientId = await fx.newPatient();
  await fx.run((tx) =>
    tx.insert(patientConsent).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      patientId,
      kind: 'whatsapp',
      granted: true,
      at: NOW,
      method: 'verbal_recorded',
    }),
  );
  const r = await fx.run((tx) =>
    enqueueMessage(
      tx,
      {
        facilityId: fx.f.facilityId,
        patientId,
        kind: 'receipt',
        entityId: uuidv7(),
        variables: { amount: '₹500.00', receiptNo: 'RC/26-27/000001', date: '26-Oct-2026' },
        sendAfter: NOW,
        ...over,
      },
      NOW,
    ),
  );
  return { patientId, id: r.id! };
}
const row = async (id: string) =>
  (await fx.t.app.select().from(messageOutbox).where(eq(messageOutbox.id, id)))[0]!;

describe('worker outbox.whatsapp (MSG-01)', () => {
  it('is registered with its sibling reminder.daily job', () => {
    const names = JOBS.map((j) => j.name);
    expect(names).toContain(OUTBOX_WHATSAPP_QUEUE);
    expect(names).toContain(REMINDER_DAILY_QUEUE);
  });

  it('sends a due message once, with the hospital name filled in, and records the provider id', async () => {
    const p = new FakeProvider();
    const m = await queued();
    await drain(p, NOW);
    const sent = p.sent.filter((s) => s.to === '919876500000');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'template',
      templateName: 'hmis_receipt_hi',
      language: 'hi',
    });
    expect(sent[0]!.params).toEqual([
      expect.any(String),
      '₹500.00',
      'RC/26-27/000001',
      '26-Oct-2026',
    ]);
    expect(sent[0]!.params![0]).not.toBe('-');
    expect(await row(m.id)).toMatchObject({
      status: 'sent',
      attempts: 1,
      providerMessageId: sent[0]!.providerMessageId,
    });
    // Draining again does not send it again.
    const before = p.calls;
    await drain(p, new Date(NOW.getTime() + minutes(5)));
    expect(p.calls).toBe(before);
  });

  it('two workers draining at the same time send each message once', async () => {
    const p = new FakeProvider();
    const ids = await Promise.all([queued(), queued(), queued()]);
    await Promise.all([drain(p, NOW), drain(p, NOW)]);
    expect(p.calls).toBe(3);
    for (const m of ids) expect((await row(m.id)).status).toBe('sent');
  });

  it('a retry after a crash between sending and saving does not send a second message', async () => {
    const p = new FakeProvider();
    const m = await queued();
    await drain(p, NOW);
    expect(p.sent).toHaveLength(1);
    // The worker died before `sent` was saved: the claim expires and the row is queued again.
    await fx.t.owner
      .update(messageOutbox)
      .set({ status: 'queued', providerMessageId: null, sentAt: null })
      .where(eq(messageOutbox.id, m.id));
    await drain(p, new Date(NOW.getTime() + minutes(20)));
    expect(p.calls).toBe(2);
    expect(p.sent).toHaveLength(1);
    expect((await row(m.id)).providerMessageId).toBe(p.sent[0]!.providerMessageId);
  });

  it('retries a temporary error with backoff and sends when the internet is back', async () => {
    const p = new FakeProvider().failNext(2);
    const m = await queued();
    const r1 = await drain(p, NOW);
    expect(r1).toMatchObject({ retried: 1, sent: 0 });
    const a = await row(m.id);
    expect(a).toMatchObject({ status: 'queued', attempts: 1, lastError: 'fake:unavailable' });
    expect(a.sendAfter.getTime() - NOW.getTime()).toBe(minutes(1));
    // Not yet due: nothing is tried.
    await drain(p, new Date(NOW.getTime() + minutes(0.5)));
    expect(p.calls).toBe(1);
    const t2 = a.sendAfter;
    await drain(p, t2);
    const b = await row(m.id);
    expect(b).toMatchObject({ status: 'queued', attempts: 2 });
    expect(b.sendAfter.getTime() - t2.getTime()).toBe(minutes(2));
    const r3 = await drain(p, b.sendAfter);
    expect(r3.sent).toBe(1);
    expect(await row(m.id)).toMatchObject({ status: 'sent', attempts: 3, lastError: null });
  });

  it('gives up after 48 hours of failures and marks the message failed', async () => {
    const p = new FakeProvider().failForever();
    const m = await queued();
    let at = NOW;
    for (let i = 0; i < 200; i += 1) {
      await drain(p, at);
      const r = await row(m.id);
      if (r.status === 'failed') break;
      expect(r.status).toBe('queued');
      at = r.sendAfter;
    }
    const last = await row(m.id);
    expect(last.status).toBe('failed');
    expect(last.lastError).toBe('fake:down');
    expect(at.getTime() - NOW.getTime()).toBeGreaterThan(hours(44));
    expect(at.getTime() - NOW.getTime()).toBeLessThanOrEqual(hours(48));
    expect(p.sent).toHaveLength(0);
    // A failed message is not picked up again.
    const calls = p.calls;
    await drain(p, new Date(at.getTime() + hours(5)));
    expect(p.calls).toBe(calls);
  });

  it('fails a permanent error (bad number, rejected template) at once', async () => {
    const p = new FakeProvider().failNext(1, false, 'meta:400:131026');
    const m = await queued();
    const r = await drain(p, NOW);
    expect(r.failed).toBe(1);
    expect(await row(m.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'meta:400:131026',
    });
  });

  it('never sends after the consent was withdrawn', async () => {
    const p = new FakeProvider();
    const m = await queued();
    await fx.run((tx) =>
      tx.insert(patientConsent).values({
        id: uuidv7(),
        facilityId: fx.f.facilityId,
        patientId: m.patientId,
        kind: 'whatsapp',
        granted: false,
        at: new Date(NOW.getTime() + 1000),
        method: 'verbal_recorded',
      }),
    );
    const r = await drain(p, new Date(NOW.getTime() + minutes(1)));
    expect(r.skippedNoConsent).toBe(1);
    expect(p.calls).toBe(0);
    expect((await row(m.id)).status).toBe('skipped_no_consent');
  });

  it('keeps messages queued while WhatsApp is off', async () => {
    const p = new FakeProvider();
    const m = await queued();
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', false));
    await drain(p, NOW);
    expect(p.calls).toBe(0);
    expect((await row(m.id)).status).toBe('queued');
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
    await drain(p, NOW);
    expect((await row(m.id)).status).toBe('sent');
  });

  it('waits for an approved template when the provider needs one, without using attempts', async () => {
    class Strict extends FakeProvider {
      override readonly requiresApprovedTemplates = true;
    }
    const p = new Strict();
    const m = await queued();
    const r = await drain(p, NOW);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    expect(await row(m.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      lastError: 'template_not_approved',
    });
    await fx.run((tx) => setTemplatesApproved(tx, fx.f.facilityId, true));
    const later = new Date(NOW.getTime() + minutes(20));
    await drain(p, later);
    expect((await row(m.id)).status).toBe('sent');
  });

  it('keeps messages queued, and does not throw, when the provider cannot be built (no login on this server)', async () => {
    const m = await queued();
    const r = await processOutbox({
      db: fx.t.app,
      filesDir: '/nonexistent',
      logger,
      providerFor: () => {
        throw new Error('meta:not_configured');
      },
      now: () => NOW,
    });
    expect(r.sent).toBe(0);
    expect(await row(m.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});
