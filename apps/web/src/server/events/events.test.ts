import { createVisit, issueToken, withTx } from '@hmis/db';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { setupAuthFixture, type AuthFixture } from '../../../test/auth-fixture';
import { EventHub, EVENTS_CHANNEL, type HubSignal } from './hub';
import { createEventStream } from './stream';

let f: AuthFixture;
let url: string;
let opd: Omit<OpdFixture, 't' | 'f'>;
const hubs: EventHub[] = [];

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  url = f.t.owner.$client.options.connectionString!;
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
});
afterAll(async () => {
  await Promise.all(hubs.map((h) => h.stop()));
  await f.close();
});

const newHub = async () => {
  const hub = new EventHub({ connectionString: url, retryMinMs: 50, retryMaxMs: 200 });
  hubs.push(hub);
  await hub.start();
  return hub;
};
const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const notify = (payload: unknown) =>
  f.t.owner.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(payload)})`);

describe('event hub (LISTEN/NOTIFY → listeners)', () => {
  it('delivers a facility’s events to its subscribers only', async () => {
    const hub = await newHub();
    const mine: HubSignal[] = [];
    const theirs: HubSignal[] = [];
    hub.subscribe(f.a.facilityId, (s) => mine.push(s));
    hub.subscribe(f.b.facilityId, (s) => theirs.push(s));
    const doctorId = uuidv7();
    await notify({ f: f.a.facilityId, t: 'queue', d: doctorId });
    await until(() => mine.length === 1);
    expect(mine[0]).toEqual({ kind: 'change', event: { topic: 'queue', doctorId } });
    expect(theirs).toEqual([]);
  });

  it('ignores malformed or foreign payloads', async () => {
    const hub = await newHub();
    const got: HubSignal[] = [];
    hub.subscribe(f.a.facilityId, (s) => got.push(s));
    await f.t.owner.execute(sql`select pg_notify(${EVENTS_CHANNEL}, 'not json')`);
    await notify({ f: 'nope', t: 'queue' });
    await notify({ f: f.a.facilityId, t: 'unknown' });
    await notify({ f: f.a.facilityId, t: 'queue' });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ kind: 'change', event: { topic: 'queue', doctorId: undefined } });
  });

  it('is fed by a real token write, with ids only', async () => {
    const hub = await newHub();
    const got: HubSignal[] = [];
    hub.subscribe(f.a.facilityId, (s) => got.push(s));
    const patientId = await opd.newPatient();
    const ctx = { db: f.db, userId: f.users.reception.id, facilityId: f.a.facilityId };
    const actor = { facilityId: f.a.facilityId, userId: f.users.reception.id };
    const v = await withTx(ctx, (tx) =>
      createVisit(
        tx,
        actor,
        { patientId, doctorId: opd.doctorA, idempotencyKey: uuidv7() },
        new Date(),
      ),
    );
    expect(v.tokenId).toBeNull(); // fee ₹500: no token, so no queue event yet
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([]);
    await withTx(ctx, (tx) =>
      issueToken(tx, actor, v.encounterId, 'manual_fee_pending', new Date()),
    );
    await until(() => got.length >= 1);
    expect(got[0]).toEqual({ kind: 'change', event: { topic: 'queue', doctorId: opd.doctorA } });
  });

  it('reconnects after the listener connection is killed: down, then reset', async () => {
    const hub = await newHub();
    const got: HubSignal['kind'][] = [];
    hub.subscribe(f.a.facilityId, (s) => got.push(s.kind));
    await f.t.owner.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'hmis-web-events'`,
    );
    await until(() => got.includes('down'));
    await until(() => got.includes('reset') && hub.isUp);
    const after: HubSignal[] = [];
    hub.subscribe(f.a.facilityId, (s) => after.push(s));
    await notify({ f: f.a.facilityId, t: 'queue' });
    await until(() => after.length === 1);
  });

  it('keeps retrying while Postgres is unreachable and never throws', async () => {
    const hub = new EventHub({
      connectionString: 'postgres://nobody:x@127.0.0.1:1/none',
      retryMinMs: 20,
      retryMaxMs: 40,
    });
    hubs.push(hub);
    await hub.start();
    expect(hub.isUp).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.isUp).toBe(false);
  });
});

describe('SSE stream', () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: RegExp) {
    const dec = new TextDecoder();
    let text = '';
    for (let i = 0; i < 20 && !needle.test(text); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    return text;
  }

  it('sends ready, change events, heartbeats and ends on abort', async () => {
    const hub = await newHub();
    const ctl = new AbortController();
    const stream = createEventStream(hub, f.a.facilityId, { heartbeatMs: 40, signal: ctl.signal });
    const reader = stream.getReader();
    expect(await readUntil(reader, /event: ready/)).toContain('retry: 3000');
    const doctorId = uuidv7();
    await notify({ f: f.a.facilityId, t: 'queue', d: doctorId });
    const text = await readUntil(reader, /event: change/);
    expect(text).toContain(`data: {"t":"queue","d":"${doctorId}"}`);
    expect(await readUntil(reader, /keep-alive/)).toContain(': keep-alive');
    ctl.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it('ends when the hub goes down so the client falls back to polling', async () => {
    const hub = await newHub();
    const reader = createEventStream(hub, f.a.facilityId).getReader();
    await readUntil(reader, /event: ready/);
    await f.t.owner.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'hmis-web-events'`,
    );
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done ?? false;
    expect(done).toBe(true);
  });

  it('ends a stream that is too old so the session is re-checked', async () => {
    const hub = await newHub();
    const reader = createEventStream(hub, f.a.facilityId, { maxAgeMs: 50 }).getReader();
    await readUntil(reader, /event: ready/);
    expect((await reader.read()).done).toBe(true);
  });
});
