import { opdToken } from '@hmis/db/schema';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
const who = {} as Record<
  'reception' | 'doctor' | 'assistant' | 'nurse' | 'admin' | 'cashier' | 'noRoles' | 'owner',
  TestBrowser
>;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  for (const k of [
    'reception',
    'doctor',
    'assistant',
    'nurse',
    'admin',
    'cashier',
    'noRoles',
    'owner',
  ] as const) {
    who[k] = f.browser();
    await who[k].login(f.users[k].username);
  }
});
afterAll(async () => {
  await f.close();
});

/** A booked visit with its token released by reception. */
async function waiting(doctorId = opd.doctorB) {
  const v = await who.reception.call(async (c) =>
    c.visit.create({ patientId: await opd.newPatient(), doctorId, idempotencyKey: uuidv7() }),
  );
  const t = await who.reception.call((c) => c.visit.issueToken({ encounterId: v.encounterId }));
  return t.tokenId;
}

const stateOf = async (id: string) =>
  (await f.db.select().from(opdToken).where(eq(opdToken.id, id)))[0]!.queueState;

describe('queue permissions (AGENTS.md rule 6)', () => {
  it('shows the board to everyone who may view patients, and to nobody else', async () => {
    for (const k of ['reception', 'doctor', 'assistant', 'nurse', 'owner'] as const) {
      const board = await who[k].call((c) => c.queue.board({}));
      expect(board.columns.map((c) => c.doctor.displayName)).toContain('Dr. B');
    }
    for (const k of ['admin', 'cashier', 'noRoles'] as const) {
      expect((await trpcError(who[k].call((c) => c.queue.board({})))).code).toBe('FORBIDDEN');
    }
    expect((await trpcError(f.browser().call((c) => c.queue.board({})))).code).toBe('UNAUTHORIZED');
  });

  it('lets the doctor room call, recall, skip and mark seen, but not run the desk', async () => {
    const [a, b, c3] = [await waiting(), await waiting(), await waiting()];
    for (const k of ['doctor', 'assistant', 'nurse'] as const) {
      const called = await who[k].call((c) => c.queue.callNext({ doctorId: opd.doctorB }));
      expect(called.queueState).toBe('with_doctor');
      await who[k].call((c) => c.queue.recall({ tokenId: called.id }));
      await who[k].call((c) => c.queue.markSeen({ tokenId: called.id }));
    }
    expect([await stateOf(a), await stateOf(b), await stateOf(c3)]).toEqual([
      'seen',
      'seen',
      'seen',
    ]);

    const fresh = await waiting();
    for (const k of ['doctor', 'assistant', 'nurse'] as const) {
      for (const call of [
        () => who[k].call((c) => c.queue.markNoShow({ tokenId: fresh, reason: 'left early' })),
        () => who[k].call((c) => c.queue.reinstate({ tokenId: fresh })),
        () => who[k].call((c) => c.queue.transfer({ tokenId: fresh, doctorId: opd.doctorA })),
        () => who[k].call((c) => c.queue.setPriority({ tokenId: fresh, priority: 'vip' })),
      ]) {
        expect((await trpcError(call())).code).toBe('FORBIDDEN');
      }
    }
    expect(await stateOf(fresh)).toBe('waiting');
  });

  it('refuses the doctor-room actions to admin, cashier and users without roles', async () => {
    const t = await waiting();
    for (const k of ['admin', 'cashier', 'noRoles'] as const) {
      for (const call of [
        () => who[k].call((c) => c.queue.callNext({ doctorId: opd.doctorB })),
        () => who[k].call((c) => c.queue.sendIn({ tokenId: t })),
        () => who[k].call((c) => c.queue.skip({ tokenId: t })),
        () => who[k].call((c) => c.queue.markSeen({ tokenId: t })),
        () => who[k].call((c) => c.queue.markDone({ tokenId: t })),
      ]) {
        expect((await trpcError(call())).code).toBe('FORBIDDEN');
      }
    }
  });
});

describe('queue procedures', () => {
  it('runs a patient through the desk and the room, with i18n errors for bad moves', async () => {
    const t = await waiting(opd.doctorA);
    await who.reception.call((c) => c.queue.setPriority({ tokenId: t, priority: 'elderly' }));
    await who.reception.call((c) => c.queue.transfer({ tokenId: t, doctorId: opd.doctorB }));
    const called = await who.doctor.call((c) => c.queue.sendIn({ tokenId: t }));
    expect(called.queueState).toBe('with_doctor');
    const bad = await trpcError(who.doctor.call((c) => c.queue.sendIn({ tokenId: t })));
    expect([bad.code, bad.message]).toEqual(['CONFLICT', 'errors.queue.invalidTransition']);
    await who.doctor.call((c) => c.queue.markSeen({ tokenId: t }));
    await who.doctor.call((c) => c.queue.markDone({ tokenId: t }));
    expect(await stateOf(t)).toBe('done');
    const gone = await trpcError(who.doctor.call((c) => c.queue.markSeen({ tokenId: uuidv7() })));
    expect([gone.code, gone.message]).toEqual(['NOT_FOUND', 'errors.queue.tokenNotFound']);
  });

  it('requires a reason for no-show and reports an empty queue plainly', async () => {
    const t = await waiting();
    const e = await trpcError(
      who.reception.call((c) => c.queue.markNoShow({ tokenId: t, reason: ' ' })),
    );
    expect(e.code).toBe('BAD_REQUEST');
    await who.reception.call((c) => c.queue.markNoShow({ tokenId: t, reason: 'Went home' }));
    expect(await stateOf(t)).toBe('no_show');
    await who.reception.call((c) => c.queue.reinstate({ tokenId: t }));
    expect(await stateOf(t)).toBe('waiting');
    await who.doctor.call((c) => c.queue.markDone({ tokenId: t }));
    const empty = await trpcError(
      who.doctor.call((c) => c.queue.callNext({ doctorId: opd.doctorA })),
    );
    expect([empty.code, empty.message]).toEqual(['CONFLICT', 'errors.queue.nothingWaiting']);
  });

  it('limits the board to the chosen doctors', async () => {
    await waiting(opd.doctorA);
    const board = await who.assistant.call((c) => c.queue.board({ doctorIds: [opd.doctorA] }));
    expect(board.columns.map((c) => c.doctor.displayName)).toEqual(['Dr. A']);
  });
});
