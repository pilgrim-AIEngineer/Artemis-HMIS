import { rotateDisplayKey, withTx } from '@hmis/db';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { patient } from '@hmis/db/schema';
import { DISPLAY_KEY_HEADER, type DisplayFeed } from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { setupAuthFixture, type AuthFixture } from '../../../../../test/auth-fixture';
import { GET } from './route';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
let key: string;
const g = globalThis as unknown as { hmisDb?: unknown };

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  g.hmisDb = f.db;
  key = await withTx({ db: f.db, userId: f.users.owner.id, facilityId: f.a.facilityId }, (tx) =>
    rotateDisplayKey(tx, f.a.facilityId),
  );
});
afterAll(async () => {
  delete g.hmisDb;
  await f.close();
});

const call = (headers: Record<string, string>) =>
  GET(new Request('http://localhost/api/display/queue', { headers }));

describe('GET /api/display/queue (REG-05)', () => {
  it('answers 404 without a key, with a wrong key and with the key in the URL', async () => {
    expect((await call({})).status).toBe(404);
    expect((await call({ [DISPLAY_KEY_HEADER]: 'A'.repeat(43) })).status).toBe(404);
    const viaUrl = await GET(new Request(`http://localhost/api/display/queue?key=${key}`));
    expect(viaUrl.status).toBe(404);
  });

  it('serves tokens only, uncached, with no session', async () => {
    const reception = f.browser();
    await reception.login(f.users.reception.username);
    const patientId = await opd.newPatient();
    await f.db
      .update(patient)
      .set({ firstName: 'Meena', lastName: 'Tiwari', mobile: '9415201234' })
      .where(eq(patient.id, patientId));
    const v = await reception.call((c) =>
      c.visit.create({ patientId, doctorId: opd.doctorB, idempotencyKey: crypto.randomUUID() }),
    );
    await reception.call((c) => c.visit.issueToken({ encounterId: v.encounterId }));

    const res = await call({ [DISPLAY_KEY_HEADER]: key });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const text = await res.text();
    const feed = JSON.parse(text) as DisplayFeed;
    expect(feed.doctors.find((d) => d.name === 'Dr. B')!.next.length).toBeGreaterThan(0);
    for (const secret of ['Meena', 'Tiwari', '9415', 'uhid', 'dob']) {
      expect(text).not.toContain(secret);
    }
  });

  it('stops answering a rotated key and slows down repeated wrong keys', async () => {
    const old = key;
    key = await withTx({ db: f.db, userId: f.users.owner.id, facilityId: f.a.facilityId }, (tx) =>
      rotateDisplayKey(tx, f.a.facilityId),
    );
    expect((await call({ [DISPLAY_KEY_HEADER]: old })).status).toBe(404);
    expect((await call({ [DISPLAY_KEY_HEADER]: key })).status).toBe(200);

    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await call({ [DISPLAY_KEY_HEADER]: 'B'.repeat(43) })).status;
    }
    expect(last).toBe(429);
  });
});
