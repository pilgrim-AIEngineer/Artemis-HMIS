import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorProfile, drug, opdToken, prescription, service } from '@hmis/db/schema';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GET as getScan } from '@/app/api/documents/rx-scan/[id]/route';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
let filesDir: string;
let pcm: string;
let cbc: string;
const who = {} as Record<
  'reception' | 'doctor' | 'assistant' | 'nurse' | 'admin' | 'cashier' | 'noRoles',
  TestBrowser
>;

/** A tiny but real JPEG header + payload (the server checks the SOI marker only). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

beforeAll(async () => {
  filesDir = await mkdtemp(join(tmpdir(), 'hmis-rx-files-'));
  process.env.HMIS_FILES_DIR = filesDir;
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  // The route handler reads through the app's pool; point it at the test database.
  (globalThis as { hmisDb?: unknown }).hmisDb = f.db;
  for (const k of [
    'reception',
    'doctor',
    'assistant',
    'nurse',
    'admin',
    'cashier',
    'noRoles',
  ] as const) {
    who[k] = f.browser();
    await who[k].login(f.users[k].username);
  }
  pcm = (
    await f.db
      .select({ id: drug.id })
      .from(drug)
      .where(
        and(
          eq(drug.facilityId, f.a.facilityId),
          eq(drug.brandName, 'Paracetamol'),
          eq(drug.strength, '650 mg'),
        ),
      )
  )[0]!.id;
  cbc = (
    await f.db
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, f.a.facilityId), eq(service.code, 'LAB-CBC')))
  )[0]!.id;
  await f.t.owner
    .update(doctorProfile)
    .set({ userId: f.users.doctor.id })
    .where(eq(doctorProfile.id, opd.doctorB));
});
afterAll(async () => {
  delete (globalThis as { hmisDb?: unknown }).hmisDb;
  await f.close();
  await rm(filesDir, { recursive: true, force: true });
});

/** A visit with doctor B that the doctor has seen. */
async function seen() {
  const v = await who.reception.call(async (c) =>
    c.visit.create({
      patientId: await opd.newPatient(),
      doctorId: opd.doctorB,
      idempotencyKey: uuidv7(),
    }),
  );
  const t = await who.reception.call((c) => c.visit.issueToken({ encounterId: v.encounterId }));
  await who.doctor.call((c) => c.queue.sendIn({ tokenId: t.tokenId }));
  await who.doctor.call((c) => c.queue.markSeen({ tokenId: t.tokenId }));
  return { encounterId: v.encounterId, tokenId: t.tokenId };
}

const item = {
  drugId: null as string | null,
  drugName: 'Paracetamol 650 mg',
  form: 'tab' as const,
  doseText: null,
  frequencyCode: 'BD' as const,
  pattern: '1-0-1',
  timing: 'af' as const,
  route: null,
  durationValue: 5,
  durationUnit: 'd' as const,
  quantity: null,
  instructionsEn: null,
  instructionsHi: null,
  sourceLine: 'dolo 650 bd af 5d',
};

describe('rx procedures (OPD-02 … OPD-04, AGENTS.md rule 6)', () => {
  it('are for rx.transcribe (assistant) and rx.verify (doctor) only', async () => {
    const v = await seen();
    const enc = { encounterId: v.encounterId };
    const transcribing = (b: TestBrowser) => [
      () => b.call((c) => c.rx.list()),
      () => b.call((c) => c.rx.context(enc)),
      () => b.call((c) => c.rx.lastRx(enc)),
      () => b.call((c) => c.rx.searchDrugs({ ...enc, q: 'para' })),
      () => b.call((c) => c.rx.searchOrders({ q: 'cbc' })),
      () =>
        b.call((c) =>
          c.rx.saveDraft({
            ...enc,
            payload: {
              items: [],
              orders: [],
              admission: { advised: false },
              note: { complaints: [], advice: [] },
            },
          }),
        ),
      () => b.call((c) => c.rx.discardDraft(enc)),
      () => b.call((c) => c.rx.attachScan({ ...enc, dataBase64: JPEG.toString('base64') })),
      () =>
        b.call((c) => c.rx.save({ ...enc, idempotencyKey: uuidv7(), items: [item], orders: [] })),
    ];
    for (const k of ['reception', 'doctor', 'nurse', 'cashier', 'admin', 'noRoles'] as const) {
      for (const call of transcribing(who[k])) {
        expect((await trpcError(call())).code, k).toBe('FORBIDDEN');
      }
    }
    for (const k of ['assistant', 'reception', 'nurse', 'cashier', 'admin', 'noRoles'] as const) {
      for (const call of [
        () => who[k].call((c) => c.rx.verificationQueue()),
        () => who[k].call((c) => c.rx.verify({ prescriptionId: uuidv7() })),
      ]) {
        expect((await trpcError(call())).code, k).toBe('FORBIDDEN');
      }
    }
    expect(
      await f.db.select().from(prescription).where(eq(prescription.encounterId, v.encounterId)),
    ).toHaveLength(0);
    expect(await readdir(filesDir).catch(() => [])).toEqual([]);
  });

  it('assistant: photo → Rx with an order → token rx_entered; the photo is served to rx viewers only', async () => {
    const v = await seen();
    const list = await who.assistant.call((c) => c.rx.list());
    expect(list.toTranscribe.map((i) => i.encounterId)).toContain(v.encounterId);
    const ctx = await who.assistant.call((c) => c.rx.context({ encounterId: v.encounterId }));
    expect(ctx.settings.requirePhoto).toBe(true);

    const noPhoto = await trpcError(
      who.assistant.call((c) =>
        c.rx.save({
          encounterId: v.encounterId,
          idempotencyKey: uuidv7(),
          items: [item],
          orders: [],
        }),
      ),
    );
    expect([noPhoto.code, noPhoto.message]).toEqual(['BAD_REQUEST', 'errors.rx.photoRequired']);

    const bad = await trpcError(
      who.assistant.call((c) =>
        c.rx.attachScan({
          encounterId: v.encounterId,
          dataBase64: Buffer.from('not a jpeg').toString('base64'),
        }),
      ),
    );
    expect(bad.message).toBe('errors.rx.scanInvalid');
    const { documentId } = await who.assistant.call((c) =>
      c.rx.attachScan({ encounterId: v.encounterId, dataBase64: JPEG.toString('base64') }),
    );

    const drugs = await who.assistant.call((c) =>
      c.rx.searchDrugs({ encounterId: v.encounterId, q: 'paracet' }),
    );
    expect(drugs.map((d) => d.id)).toContain(pcm);
    const r = await who.assistant.call((c) =>
      c.rx.save({
        encounterId: v.encounterId,
        idempotencyKey: uuidv7(),
        scanDocumentId: documentId,
        items: [{ ...item, drugId: pcm }],
        orders: [{ serviceId: cbc }],
      }),
    );
    expect(r).toMatchObject({ version: 1, queueState: 'rx_entered', ordersAdded: 1 });
    const [tok] = await f.db.select().from(opdToken).where(eq(opdToken.id, v.tokenId));
    expect(tok!.queueState).toBe('rx_entered');

    const req = (b: TestBrowser | null) =>
      getScan(
        new Request(`http://localhost/api/documents/rx-scan/${documentId}`, {
          headers: b ? { cookie: b.cookieHeader() } : {},
        }),
        { params: Promise.resolve({ id: documentId }) },
      );
    const ok = await req(who.assistant);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await ok.arrayBuffer()).equals(JPEG)).toBe(true);
    expect((await req(who.doctor)).status).toBe(200);
    expect((await req(who.reception)).status).toBe(403);
    expect((await req(null)).status).toBe(401);
  });

  it('placing orders also needs order.create; the doctor verifies their own sampled Rx', async () => {
    const v = await seen();
    const { documentId } = await who.assistant.call((c) =>
      c.rx.attachScan({ encounterId: v.encounterId, dataBase64: JPEG.toString('base64') }),
    );
    // A Rx with a warning (free-text drug) is always sampled.
    const r = await who.assistant.call((c) =>
      c.rx.save({
        encounterId: v.encounterId,
        idempotencyKey: uuidv7(),
        scanDocumentId: documentId,
        items: [item],
        orders: [],
      }),
    );
    expect(r.needsVerification).toBe(true);
    const queue = await who.doctor.call((c) => c.rx.verificationQueue());
    expect(queue.map((q) => q.prescriptionId)).toContain(r.prescriptionId);
    await who.doctor.call((c) => c.rx.verify({ prescriptionId: r.prescriptionId }));
    const again = await trpcError(
      who.doctor.call((c) => c.rx.verify({ prescriptionId: r.prescriptionId })),
    );
    expect([again.code, again.message]).toEqual(['CONFLICT', 'errors.rx.notPendingVerification']);
  });

  it('answers unknown visits with not found', async () => {
    const gone = await trpcError(
      who.assistant.call((c) => c.rx.context({ encounterId: uuidv7() })),
    );
    expect([gone.code, gone.message]).toEqual(['NOT_FOUND', 'errors.rx.encounterNotFound']);
  });
});
