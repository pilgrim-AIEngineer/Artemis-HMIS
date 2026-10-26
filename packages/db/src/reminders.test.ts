import { addDays, createPregnancySchema, parseIsoDate, toIsoDate } from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { clinicalNote, messageOutbox, patientConsent } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { activePregnancies, createPregnancy } from './anc';
import { queueDailyReminders } from './reminders';
import { writeSetting } from './settings';

let fx: OpdFixture;
const BOOKED = IST('2026-10-26T10:00:00');
const at7pm = (date: string) => IST(`${date}T19:00:00`);
const plus = (d: string, n: number) => toIsoDate(addDays(parseIsoDate(d), n));

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
});
afterAll(async () => {
  await fx.t.close();
});

const agree = (patientId: string) =>
  fx.run((tx) =>
    tx.insert(patientConsent).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      patientId,
      kind: 'whatsapp',
      granted: true,
      at: BOOKED,
      method: 'verbal_recorded',
    }),
  );
const outbox = (patientId: string) =>
  fx.t.app.select().from(messageOutbox).where(eq(messageOutbox.patientId, patientId));

describe('reminder.daily run (MSG-01)', () => {
  it('queues the follow-up reminder 1 day before the date, for 10 am, once', async () => {
    const patientId = await fx.newPatient();
    await agree(patientId);
    const v = await fx.visit({ patientId }, BOOKED);
    const followUp = '2026-11-05';
    await fx.t.owner.insert(clinicalNote).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      encounterId: v.encounterId,
      patientId,
      followUpDate: followUp,
      enteredBy: fx.f.userId,
    });
    // 7 pm on 3 Nov: tomorrow is the 4th, and the reminder is for visits of the 5th.
    const early = await queueDailyReminders(fx.t.app, fx.f.facilityId, at7pm('2026-11-02'));
    expect(early.followUp).toBe(0);
    const run = await queueDailyReminders(fx.t.app, fx.f.facilityId, at7pm('2026-11-03'));
    expect(run.followUp).toBe(1);
    const [msg] = await outbox(patientId);
    expect(msg).toMatchObject({ templateKind: 'follow_up', status: 'queued' });
    expect(msg!.sendAfter).toEqual(IST('2026-11-04T10:00:00'));
    expect(msg!.variables).toMatchObject({ date: '05-Nov-2026' });
    // The same run twice does not message twice.
    const again = await queueDailyReminders(fx.t.app, fx.f.facilityId, at7pm('2026-11-03'));
    expect(again.followUp).toBe(0);
    expect(await outbox(patientId)).toHaveLength(1);
  });

  it('does not queue anything for a patient without consent beyond the withheld record', async () => {
    const patientId = await fx.newPatient();
    const v = await fx.visit({ patientId }, BOOKED);
    await fx.t.owner.insert(clinicalNote).values({
      id: uuidv7(),
      facilityId: fx.f.facilityId,
      encounterId: v.encounterId,
      patientId,
      followUpDate: '2026-12-05',
      enteredBy: fx.f.userId,
    });
    const run = await queueDailyReminders(fx.t.app, fx.f.facilityId, at7pm('2026-12-03'));
    expect(run.followUp).toBe(0);
    expect((await outbox(patientId)).map((m) => m.status)).toEqual(['skipped_no_consent']);
  });

  it('queues the ANC reminder 2 days before the suggested visit', async () => {
    const patientId = await fx.newPatient();
    await agree(patientId);
    await fx.run((tx) =>
      createPregnancy(
        tx,
        { facilityId: fx.f.facilityId, userId: fx.f.userId, mtp: { view: false, edit: false } },
        createPregnancySchema.parse({ patientId, idempotencyKey: uuidv7(), lmp: '2026-07-20' }),
        BOOKED,
      ),
    );
    const list = await activePregnancies(
      fx.t.app,
      { facilityId: fx.f.facilityId, userId: fx.f.userId, mtp: { view: false, edit: false } },
      BOOKED,
    );
    const due = list.find((p) => p.patientId === patientId)!.nextVisit!.date;
    // Visit on D: the reminder goes at 10 am on D-2, queued by the run at 7 pm on D-3.
    const run = await queueDailyReminders(fx.t.app, fx.f.facilityId, at7pm(plus(due, -3)));
    expect(run.anc).toBe(1);
    const [msg] = await outbox(patientId);
    expect(msg).toMatchObject({ templateKind: 'anc_reminder', status: 'queued' });
    expect(msg!.sendAfter).toEqual(IST(`${plus(due, -2)}T10:00:00`));
  });

  it('does nothing while WhatsApp is off', async () => {
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', false));
    const run = await queueDailyReminders(fx.t.app, fx.f.facilityId, at7pm('2026-11-03'));
    expect(run).toEqual({ followUp: 0, anc: 0, vaccine: 0 });
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'whatsapp.enabled', true));
  });
});
