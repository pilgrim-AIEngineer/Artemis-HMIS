import { encounter, opdToken, queueEvent } from '@hmis/db/schema';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
let reception: TestBrowser;
let doctor: TestBrowser;
let assistant: TestBrowser;
let nurse: TestBrowser;
let admin: TestBrowser;
let owner: TestBrowser;
let noRoles: TestBrowser;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  const login = async (u: { username: string }) => {
    const b = f.browser();
    await b.login(u.username);
    return b;
  };
  [reception, doctor, assistant, nurse, admin, owner, noRoles] = await Promise.all([
    login(f.users.reception),
    login(f.users.doctor),
    login(f.users.assistant),
    login(f.users.nurse),
    login(f.users.admin),
    login(f.users.owner),
    login(f.users.noRoles),
  ]);
});
afterAll(async () => {
  await f.close();
});

const book = (b: TestBrowser, over: Record<string, unknown> = {}) =>
  b.call(async (c) =>
    c.visit.create({
      patientId: await opd.newPatient(),
      doctorId: opd.doctorB,
      idempotencyKey: uuidv7(),
      ...over,
    }),
  );

describe('visit permissions (AGENTS.md rule 6)', () => {
  it('lets reception list doctors, preview and create a visit', async () => {
    const docs = await reception.call((c) => c.visit.doctors());
    expect(docs.map((d) => d.displayName)).toEqual(['Dr. A', 'Dr. B']);
    const patientId = await opd.newPatient();
    const preview = await reception.call((c) =>
      c.visit.preview({ patientId, doctorId: opd.doctorA }),
    );
    expect(preview).toMatchObject({ suggestedVisitType: 'new' });
    expect(preview.fee.ratePaise).toBe(50_000n);
    const out = await book(reception, { patientId, doctorId: opd.doctorA });
    expect(out).toMatchObject({ visitType: 'new', feePaise: '50000', tokenId: null });
  });

  it('refuses everyone without visit.create', async () => {
    const patientId = await opd.newPatient();
    for (const who of [doctor, assistant, nurse, admin, noRoles]) {
      for (const call of [
        () => who.call((c) => c.visit.doctors()),
        () => who.call((c) => c.visit.preview({ patientId, doctorId: opd.doctorA })),
        () => book(who, { patientId }),
      ]) {
        expect((await trpcError(call())).code).toBe('FORBIDDEN');
      }
    }
  });

  it('keeps the cancel and token-before-payment actions to their permission holders', async () => {
    const v = await book(reception);
    expect(
      (
        await trpcError(
          reception.call((c) => c.visit.cancel({ encounterId: v.encounterId, reason: 'wrong' })),
        )
      ).code,
    ).toBe('FORBIDDEN');
    // reception collects money by default (billing.payment.collect), so it may release the token.
    const tok = await reception.call((c) => c.visit.issueToken({ encounterId: v.encounterId }));
    expect(tok.tokenNo).toBeGreaterThan(0);
    for (const who of [doctor, assistant, nurse, admin]) {
      expect(
        (await trpcError(who.call((c) => c.visit.issueToken({ encounterId: v.encounterId })))).code,
      ).toBe('FORBIDDEN');
    }
    await owner.call((c) => c.visit.cancel({ encounterId: v.encounterId, reason: 'Wrong doctor' }));
    const [enc] = await f.db.select().from(encounter).where(eq(encounter.id, v.encounterId));
    expect(enc).toMatchObject({ status: 'cancelled', cancelledBy: f.users.owner.id });
    const [t] = await f.db.select().from(opdToken).where(eq(opdToken.id, tok.tokenId));
    expect(t?.queueState).toBe('cancelled');
  });
});

describe('visit input and errors', () => {
  it('maps domain errors to i18n keys, never SQL', async () => {
    const e1 = await trpcError(book(reception, { patientId: uuidv7() }));
    expect([e1.code, e1.message]).toEqual(['NOT_FOUND', 'errors.visit.patientNotFound']);
    const e2 = await trpcError(book(reception, { doctorId: uuidv7() }));
    expect([e2.code, e2.message]).toEqual(['NOT_FOUND', 'errors.visit.doctorNotFound']);
    const e3 = await trpcError(book(reception, { visitType: 'follow_up' }));
    expect([e3.code, e3.message]).toEqual(['BAD_REQUEST', 'errors.visit.followUpNotEligible']);
    const e4 = await trpcError(book(reception, { idempotencyKey: 'not-a-uuid' }));
    expect(e4.code).toBe('BAD_REQUEST');
  });

  it('replays a double submit and reports a reused key with another payload as a conflict', async () => {
    const patientId = await opd.newPatient();
    const key = uuidv7();
    const a = await book(reception, { patientId, idempotencyKey: key });
    const b = await book(reception, { patientId, idempotencyKey: key });
    expect(b).toEqual(a);
    const e = await trpcError(
      book(reception, { patientId, doctorId: opd.doctorA, idempotencyKey: key }),
    );
    expect([e.code, e.message]).toEqual(['CONFLICT', 'errors.idempotency.conflict']);
    expect(
      await f.db.select().from(encounter).where(eq(encounter.patientId, patientId)),
    ).toHaveLength(1);
  });

  it('keeps a second visit today behind a confirmation', async () => {
    const patientId = await opd.newPatient();
    await book(reception, { patientId });
    const e = await trpcError(book(reception, { patientId }));
    expect([e.code, e.message]).toEqual(['CONFLICT', 'errors.visit.alreadyToday']);
    await book(reception, { patientId, allowRepeatToday: true, visitType: 'new' });
  });

  it('writes queue events for the token it issues', async () => {
    const v = await book(reception);
    const tok = await reception.call((c) => c.visit.issueToken({ encounterId: v.encounterId }));
    const ev = await f.db.select().from(queueEvent).where(eq(queueEvent.tokenId, tok.tokenId));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.byUser).toBe(f.users.reception.id);
  });
});
