import { createVisit, issueToken, withTx } from '@hmis/db';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { setupAuthFixture, type AuthFixture } from '../../../../test/auth-fixture';
import { EventHub } from '@/server/events/hub';
import { GET } from './route';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
let hub: EventHub;
const g = globalThis as unknown as { hmisDb?: unknown; hmisEventHub?: EventHub };

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  g.hmisDb = f.db;
  hub = new EventHub({
    connectionString: f.t.owner.$client.options.connectionString!,
    retryMinMs: 50,
  });
  g.hmisEventHub = hub;
});
afterAll(async () => {
  await hub.stop();
  delete g.hmisDb;
  delete g.hmisEventHub;
  await f.close();
});

const request = (b: { cookieHeader(): string } | null, signal?: AbortSignal) =>
  new Request('http://localhost/api/events', {
    headers: b ? { cookie: b.cookieHeader() } : {},
    signal,
  });
const login = async (username: string) => {
  const b = f.browser();
  await b.login(username);
  return b;
};

describe('GET /api/events', () => {
  it('needs a session: 401 without one, 403 without a queue permission', async () => {
    expect((await GET(request(null))).status).toBe(401);
    const forged = f.browser();
    forged.cookies.set('hmis_session', 'forged');
    expect((await GET(request(forged))).status).toBe(401);
    const none = await login(f.users.noRoles.username);
    expect((await GET(request(none))).status).toBe(403);
    const admin = await login(f.users.admin.username);
    expect((await GET(request(admin))).status).toBe(403);
  });

  it('answers 503 with Retry-After while the listener is down, so clients poll', async () => {
    const down = new EventHub({
      connectionString: 'postgres://x:y@127.0.0.1:1/none',
      retryMinMs: 1000,
    });
    g.hmisEventHub = down;
    const b = await login(f.users.reception.username);
    const res = await GET(request(b));
    await down.stop();
    g.hmisEventHub = hub;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('streams queue changes of the user’s hospital to a doctor-room tablet', async () => {
    const b = await login(f.users.assistant.username);
    const ctl = new AbortController();
    const res = await GET(request(b, ctl.signal));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    expect(text).toContain('event: ready');

    const patientId = await opd.newPatient();
    const ctx = { db: f.db, userId: f.users.reception.id, facilityId: f.a.facilityId };
    const actor = { facilityId: f.a.facilityId, userId: f.users.reception.id };
    await withTx(ctx, async (tx) => {
      const v = await createVisit(
        tx,
        actor,
        { patientId, doctorId: opd.doctorB, idempotencyKey: uuidv7() },
        new Date(),
      );
      await issueToken(tx, actor, v.encounterId, 'manual_fee_pending', new Date());
    });
    text = '';
    // Heartbeats and the change arrive on the LISTEN/NOTIFY schedule: wait for it, with a deadline.
    const deadline = Date.now() + 15_000;
    while (!text.includes('event: change') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += dec.decode(chunk.value);
    }
    expect(text).toContain(`"d":"${opd.doctorB}"`);
    ctl.abort();
  });
});
