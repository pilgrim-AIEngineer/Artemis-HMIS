import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { messageOutbox, patientConsent } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { writeSetting } from './settings';
import { enqueueMessage } from './messaging';
import { getOutboxLag } from './ops-health';
import { eq } from 'drizzle-orm';

let fx: OpdFixture;
const NOW = IST('2026-10-26T11:00:00');

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
});
afterAll(async () => {
  await fx.t.close();
});

async function queueOne(): Promise<string> {
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
        kind: 'follow_up',
        entityId: uuidv7(),
        variables: { patientName: 'Test', doctorName: 'Dr A', date: '27-Oct-2026' },
      },
      NOW,
    ),
  );
  return r.id!;
}

describe('getOutboxLag (OPS-01)', () => {
  it('is empty with nothing queued', async () => {
    expect(await getOutboxLag(fx.t.app, NOW)).toEqual({ backlog: 0, oldestAgeSeconds: null });
  });

  it('counts due, unsent messages and reports the oldest age; ignores sent and future ones', async () => {
    const due = await queueOne();
    const sent = await queueOne();
    const future = await queueOne();
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    await fx.run((tx) =>
      tx
        .update(messageOutbox)
        .set({ sendAfter: at(-600_000) })
        .where(eq(messageOutbox.id, due)),
    );
    await fx.run((tx) =>
      tx
        .update(messageOutbox)
        .set({ status: 'sent', sentAt: NOW, sendAfter: at(-900_000) })
        .where(eq(messageOutbox.id, sent)),
    );
    await fx.run((tx) =>
      tx
        .update(messageOutbox)
        .set({ sendAfter: at(3_600_000) })
        .where(eq(messageOutbox.id, future)),
    );
    expect(await getOutboxLag(fx.t.app, NOW)).toEqual({ backlog: 1, oldestAgeSeconds: 600 });
  });
});
