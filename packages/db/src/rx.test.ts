import { rupeesToPaise, type SaveRxInput } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  auditLog,
  bill,
  billLine,
  clinicalNote,
  clinicalOrder,
  doctorProfile,
  document,
  drug,
  encounter,
  opdToken,
  prescription,
  prescriptionItem,
  rxDraft,
  service,
} from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import {
  addOrdersToBill,
  billsForEncounter,
  finalizeBill,
  getBillView,
  removeBillLine,
  collectPayment,
} from './billing';
import { setServiceRate } from './masters';
import { markSeen, sendIn } from './queue';
import {
  attachRxScan,
  discardRxDraft,
  lastRxItems,
  rxContext,
  rxVerificationQueue,
  RxInputError,
  saveRx,
  saveRxDraft,
  searchDrugs,
  searchOrderables,
  transcriptionList,
  verifyRx,
} from './rx';
import { writeSetting } from './settings';
import { issueToken } from './visits';

let fx: OpdFixture;
let day = 0;
const ids = {} as Record<'pcm650' | 'folic' | 'cbc' | 'hb' | 'tsh' | 'obUsg' | 'consult', string>;

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  const drugId = async (name: string, strength: string) =>
    (
      await fx.t.app
        .select({ id: drug.id })
        .from(drug)
        .where(
          and(
            eq(drug.facilityId, fx.f.facilityId),
            eq(drug.brandName, name),
            eq(drug.strength, strength),
          ),
        )
    )[0]!.id;
  const svc = async (code: string) =>
    (
      await fx.t.app
        .select({ id: service.id })
        .from(service)
        .where(and(eq(service.facilityId, fx.f.facilityId), eq(service.code, code)))
    )[0]!.id;
  ids.pcm650 = await drugId('Paracetamol', '650 mg');
  ids.folic = await drugId('Folic acid', '5 mg');
  ids.cbc = await svc('LAB-CBC');
  ids.hb = await svc('LAB-HB');
  ids.tsh = await svc('LAB-TSH');
  ids.obUsg = await svc('USG-OB-EARLY');
  ids.consult = await svc('CONS-GYN-NEW');
  for (const [id, rupees] of [
    [ids.cbc, 300],
    [ids.tsh, 450],
    [ids.obUsg, 900],
  ] as const) {
    await fx.run((tx) =>
      setServiceRate(tx, {
        facilityId: fx.f.facilityId,
        serviceId: id,
        tariffId: fx.m.defaultTariffId,
        ratePaise: rupeesToPaise(rupees),
        effectiveFrom: '2026-01-01',
      }),
    );
  }
  // Photos are required by default (docs/11 §2.2); most tests attach one.
});
afterAll(async () => {
  await fx.t.close();
});

const nextDay = () => {
  day += 1;
  const d = String(day).padStart(2, '0');
  return (hh = '10', mm = '00') => IST(`2028-05-${d}T${hh}:${mm}:00`);
};

/** A paid-for visit with doctor A whose patient the doctor has seen. */
async function seenVisit(at: Date, patientId?: string) {
  const pid = patientId ?? (await fx.newPatient());
  const v = await fx.visit({ patientId: pid, doctorId: fx.doctorA }, at);
  // A free follow-up gets its token with the visit; a paid one is issued here.
  const tok = v.tokenId
    ? { tokenId: v.tokenId }
    : await fx.run((tx) => issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', at));
  await fx.run((tx) => sendIn(tx, fx.actor(), tok.tokenId, at));
  await fx.run((tx) => markSeen(tx, fx.actor(), tok.tokenId, at));
  return { patientId: pid, encounterId: v.encounterId, tokenId: tok.tokenId };
}

let fileN = 0;
const scan = (encounterId: string, at: Date, replacesDocumentId: string | null = null) =>
  fx.run((tx) =>
    attachRxScan(
      tx,
      fx.actor(),
      {
        encounterId,
        replacesDocumentId,
        file: {
          relPath: `${fx.f.facilityId}/2028/05/${uuidv7()}.jpg`,
          sizeBytes: 1000 + fileN++,
          sha256: 'a'.repeat(64),
        },
      },
      at,
    ),
  );

const row = (over: Partial<SaveRxInput['items'][number]> = {}): SaveRxInput['items'][number] => ({
  drugId: ids.pcm650,
  drugName: 'Paracetamol 650 mg',
  form: 'tab',
  doseText: null,
  frequencyCode: null,
  pattern: '1-0-1',
  timing: 'af',
  route: null,
  durationValue: 5,
  durationUnit: 'd',
  quantity: null,
  instructionsEn: null,
  instructionsHi: null,
  sourceLine: 'pcm 650 1-0-1 af 5d',
  ...over,
});

const save = (
  input: Omit<SaveRxInput, 'idempotencyKey'> & { idempotencyKey?: string },
  at: Date,
  random = 0.99,
) =>
  fx.run((tx) => saveRx(tx, fx.actor(), { idempotencyKey: uuidv7(), ...input }, at, () => random));
const key = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof RxInputError ? e.key : String(e)),
  );

describe('saving a transcription (OPD-02, docs/11 §2.7)', () => {
  it('stores rows with quantity and Hindi instructions, orders, note and follow-up; token → rx_entered', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const { documentId } = await scan(v.encounterId, at);
    const r = await save(
      {
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [
          row(),
          row({
            drugId: ids.folic,
            drugName: 'Folic acid 5 mg',
            pattern: '1-0-0',
            timing: null,
            durationValue: 1,
            durationUnit: 'm',
            sourceLine: null,
          }),
        ],
        orders: [{ serviceId: ids.cbc }, { serviceId: ids.obUsg, priority: 'urgent' }],
        admission: { advised: true, expectedDate: '2028-05-20', note: 'LSCS package' },
        note: { complaints: ['Fever'], diagnosis: 'Viral fever', advice: ['Plenty of fluids'] },
        followUpDate: '2028-05-08',
      },
      at,
    );
    expect(r).toMatchObject({
      version: 1,
      needsVerification: false,
      warnings: [],
      ordersAdded: 3,
      ordersCancelled: 0,
      queueState: 'rx_entered',
    });
    const [rx] = await fx.t.app
      .select()
      .from(prescription)
      .where(eq(prescription.id, r.prescriptionId));
    expect(rx).toMatchObject({
      status: 'final',
      source: 'transcribed_from_paper',
      enteredBy: fx.f.userId,
      paperScanDocumentId: documentId,
      doctorId: fx.doctorA,
    });
    const items = await fx.t.app
      .select()
      .from(prescriptionItem)
      .where(eq(prescriptionItem.prescriptionId, r.prescriptionId))
      .orderBy(prescriptionItem.seq);
    expect(
      items.map((i) => [i.drugName, i.quantityCalc, i.instructionsHi, i.instructionsEn]),
    ).toEqual([
      ['Paracetamol 650 mg', '10.000', '1-0-1, खाने के बाद, 5 दिन', '1-0-1, after food, 5 days'],
      ['Folic acid 5 mg', '30.000', '1-0-0, 1 महीना', '1-0-0, 1 month'],
    ]);
    const orders = await fx.t.app
      .select()
      .from(clinicalOrder)
      .where(eq(clinicalOrder.encounterId, v.encounterId));
    expect(orders.map((o) => [o.kind, o.status, o.priority]).sort()).toEqual([
      ['admission', 'ordered', 'routine'],
      ['lab', 'ordered', 'routine'],
      ['usg', 'ordered', 'urgent'],
    ]);
    expect(orders.find((o) => o.kind === 'usg')!.usgProcedureId).not.toBeNull();
    expect(orders.find((o) => o.kind === 'lab')!.labTestId).not.toBeNull();
    expect(orders.find((o) => o.kind === 'admission')).toMatchObject({
      serviceId: null,
      expectedDate: '2028-05-20',
      notes: 'LSCS package',
    });
    const [note] = await fx.t.app
      .select()
      .from(clinicalNote)
      .where(eq(clinicalNote.encounterId, v.encounterId));
    expect(note).toMatchObject({
      status: 'final',
      followUpDate: '2028-05-08',
      complaints: [{ text: 'Fever' }],
      provisionalDiagnosis: [{ text: 'Viral fever' }],
      advice: 'Plenty of fluids',
    });
    const [tok] = await fx.t.app.select().from(opdToken).where(eq(opdToken.id, v.tokenId));
    expect(tok!.queueState).toBe('rx_entered');
    // Audit trail (AGENTS.md rule 5).
    const audited = await fx.t.app
      .select({ table: auditLog.tableName })
      .from(auditLog)
      .where(eq(auditLog.rowId, r.prescriptionId));
    expect(audited.map((a) => a.table)).toContain('prescription');

    const ctx = await fx.run((tx) => rxContext(tx, fx.f.facilityId, v.encounterId));
    expect(ctx.current!.items).toHaveLength(2);
    expect(ctx.orders.map((o) => o.kind).sort()).toEqual(['admission', 'lab', 'usg']);
    expect(ctx.note).toMatchObject({
      complaints: ['Fever'],
      advice: ['Plenty of fluids'],
      followUpDate: '2028-05-08',
    });
    expect(ctx.scans.map((s) => s.id)).toEqual([documentId]);
  });

  it('requires the photo by default, refuses an empty Rx and bad dates or references', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const base = { encounterId: v.encounterId, items: [row()], orders: [] };
    expect(await key(save(base, at))).toBe('rx.photoRequired');
    const { documentId } = await scan(v.encounterId, at);
    const ok = { ...base, scanDocumentId: documentId };
    expect(await key(save({ ...ok, items: [] }, at))).toBe('rx.empty');
    expect(await key(save({ ...ok, followUpDate: '2028-05-02' }, at))).toBe('rx.followUpInvalid');
    expect(await key(save({ ...ok, items: [row({ drugId: uuidv7() })] }, at))).toBe(
      'rx.drugNotFound',
    );
    expect(await key(save({ ...ok, orders: [{ serviceId: ids.consult }] }, at))).toBe(
      'rx.orderNotOrderable',
    );
    expect(await key(save({ ...ok, scanDocumentId: uuidv7() }, at))).toBe('rx.scanNotFound');
    expect(
      await key(
        save({ ...ok, admission: { advised: true, expectedDate: '2028-05-01', note: null } }, at),
      ),
    ).toBe('rx.admissionDateInvalid');

    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'rx.requirePhoto', false));
    try {
      expect((await save(base, at)).version).toBe(1);
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'rx.requirePhoto', true));
    }
  });

  it('keeps free-text drugs, flags them and the duplicate, and replays a double submit', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const { documentId } = await scan(v.encounterId, at);
    const input = {
      encounterId: v.encounterId,
      scanDocumentId: documentId,
      items: [
        row(),
        row(),
        row({
          drugId: null,
          drugName: 'Syp Mystery',
          form: 'syp',
          pattern: '1-1-1',
          sourceLine: 'syp mystery tds',
        }),
      ],
      orders: [],
      idempotencyKey: uuidv7(),
    };
    const a = await save(input, at);
    const b = await save(input, at);
    expect(b).toEqual(a);
    expect(a.warnings).toEqual([
      { code: 'duplicate_drug', row: 1 },
      { code: 'free_text_drug', row: 2 },
    ]);
    // Warnings put it on the doctor's list in sample mode.
    expect(a.needsVerification).toBe(true);
    const items = await fx.t.app
      .select()
      .from(prescriptionItem)
      .where(eq(prescriptionItem.prescriptionId, a.prescriptionId));
    expect(items.find((i) => i.seq === 3)).toMatchObject({
      drugId: null,
      freeTextDrug: 'Syp Mystery',
      quantityCalc: null,
    });
    expect(
      await fx.t.app.select().from(prescription).where(eq(prescription.encounterId, v.encounterId)),
    ).toHaveLength(1);
  });

  it('a correction is the next version: old one superseded, unwanted orders cancelled, billed ones protected', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const { documentId } = await scan(v.encounterId, at);
    const first = await save(
      {
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [row()],
        orders: [{ serviceId: ids.cbc }, { serviceId: ids.tsh }],
        admission: { advised: true, expectedDate: null, note: null },
        followUpDate: '2028-05-10',
      },
      at,
    );
    const later = new Date(at.getTime() + 60_000);
    const second = await save(
      {
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [row({ pattern: '1-1-1' })],
        orders: [{ serviceId: ids.cbc }, { serviceId: ids.hb }],
      },
      later,
    );
    expect(second).toMatchObject({
      version: 2,
      ordersAdded: 1,
      ordersCancelled: 2,
      queueState: 'rx_entered',
    });
    const rxs = await fx.t.app
      .select()
      .from(prescription)
      .where(eq(prescription.encounterId, v.encounterId));
    expect(rxs.map((x) => [x.version, x.status]).sort()).toEqual([
      [1, 'superseded'],
      [2, 'final'],
    ]);
    expect(rxs.find((x) => x.version === 2)!.supersedesId).toBe(first.prescriptionId);
    const orders = await fx.t.app
      .select()
      .from(clinicalOrder)
      .where(eq(clinicalOrder.encounterId, v.encounterId));
    const state = (sid: string | null, kind = 'lab') =>
      orders
        .filter((o) => o.serviceId === sid && o.kind === kind)
        .map((o) => o.status)
        .sort();
    expect(state(ids.cbc)).toEqual(['ordered']);
    expect(state(ids.tsh)).toEqual(['cancelled']);
    expect(state(ids.hb)).toEqual(['ordered']);
    expect(state(null, 'admission')).toEqual(['cancelled']);
    const notes = await fx.t.app
      .select()
      .from(clinicalNote)
      .where(eq(clinicalNote.encounterId, v.encounterId));
    expect(notes.map((n) => n.status)).toEqual(['superseded']);

    // CBC goes on the bill; a correction can no longer drop it.
    const [draft] = await billsForEncounter(fx.t.app, fx.f.facilityId, v.encounterId);
    const cbc = orders.find((o) => o.serviceId === ids.cbc && o.status === 'ordered')!;
    await fx.run((tx) =>
      addOrdersToBill(
        tx,
        { ...fx.actor() },
        { billId: draft!.id, orderIds: [cbc.id], idempotencyKey: uuidv7() },
        later,
      ),
    );
    expect(
      await key(
        save(
          { encounterId: v.encounterId, scanDocumentId: documentId, items: [row()], orders: [] },
          later,
        ),
      ),
    ).toBe('rx.orderBilled');
  });

  it('follows rx.verifyMode (Q15): off, all, sample by random share', async () => {
    const run = async (mode: 'off' | 'all' | 'sample', random: number) => {
      const at = nextDay()();
      const v = await seenVisit(at);
      const { documentId } = await scan(v.encounterId, at);
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'rx.verifyMode', mode));
      try {
        return (
          await save(
            { encounterId: v.encounterId, scanDocumentId: documentId, items: [row()], orders: [] },
            at,
            random,
          )
        ).needsVerification;
      } finally {
        await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'rx.verifyMode', 'sample'));
      }
    };
    expect(await run('off', 0)).toBe(false);
    expect(await run('all', 0.99)).toBe(true);
    expect(await run('sample', 0.05)).toBe(true);
    expect(await run('sample', 0.5)).toBe(false);
  });

  it('refuses restricted (MTP) encounters everywhere and leaves them off the worklist', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    await fx.t.owner
      .update(encounter)
      .set({ isRestricted: true })
      .where(eq(encounter.id, v.encounterId));
    expect(await key(fx.run((tx) => rxContext(tx, fx.f.facilityId, v.encounterId)))).toBe(
      'rx.encounterNotFound',
    );
    expect(await key(save({ encounterId: v.encounterId, items: [row()], orders: [] }, at))).toBe(
      'rx.encounterNotFound',
    );
    expect(await key(scan(v.encounterId, at))).toBe('rx.encounterNotFound');
    const list = await transcriptionList(fx.t.app, fx.f.facilityId, at);
    expect([...list.toTranscribe, ...list.transcribed].map((i) => i.encounterId)).not.toContain(
      v.encounterId,
    );
  });
});

describe('worklist, drafts, photos, search (OPD-02)', () => {
  it('lists seen patients to transcribe, then as transcribed', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    let list = await transcriptionList(fx.t.app, fx.f.facilityId, at);
    expect(list.toTranscribe.map((i) => i.encounterId)).toContain(v.encounterId);
    const { documentId } = await scan(v.encounterId, at);
    await save(
      { encounterId: v.encounterId, scanDocumentId: documentId, items: [row()], orders: [] },
      at,
    );
    list = await transcriptionList(fx.t.app, fx.f.facilityId, at);
    expect(list.toTranscribe.map((i) => i.encounterId)).not.toContain(v.encounterId);
    expect(list.transcribed.find((i) => i.encounterId === v.encounterId)!.rx).toMatchObject({
      version: 1,
    });
  });

  it('autosaves one draft per visit, restores it, discards it and marks it used on save', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const payload = {
      items: [{ drugName: 'Paracetamol', pattern: '1-0-1' }],
      line: 'folvite bd',
      orders: [ids.cbc],
      admission: { advised: false },
      note: { complaints: [], advice: [] },
    };
    await fx.run((tx) => saveRxDraft(tx, fx.actor(), { encounterId: v.encounterId, payload }, at));
    const later = new Date(at.getTime() + 20_000);
    await fx.run((tx) =>
      saveRxDraft(
        tx,
        fx.actor(),
        { encounterId: v.encounterId, payload: { ...payload, line: 'folvite bd x1m' } },
        later,
      ),
    );
    let ctx = await fx.run((tx) => rxContext(tx, fx.f.facilityId, v.encounterId));
    expect(ctx.draft).toMatchObject({ savedAt: later, payload: { line: 'folvite bd x1m' } });
    await fx.run((tx) => discardRxDraft(tx, fx.actor(), v.encounterId));
    ctx = await fx.run((tx) => rxContext(tx, fx.f.facilityId, v.encounterId));
    expect(ctx.draft).toBeNull();
    await fx.run((tx) =>
      saveRxDraft(tx, fx.actor(), { encounterId: v.encounterId, payload }, later),
    );
    const { documentId } = await scan(v.encounterId, at);
    await save(
      { encounterId: v.encounterId, scanDocumentId: documentId, items: [row()], orders: [] },
      later,
    );
    const [d] = await fx.t.app.select().from(rxDraft).where(eq(rxDraft.encounterId, v.encounterId));
    expect(d!.status).toBe('used');
    // Content-only autosaves are not copied into the audit log; creation and status are.
    const audit = await fx.t.app.select().from(auditLog).where(eq(auditLog.rowId, d!.id));
    expect(audit.map((a) => a.action)).toEqual(['I', 'U', 'U', 'U']);
  });

  it('replaces a photo by cancelling the old document', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const a = await scan(v.encounterId, at);
    const b = await scan(v.encounterId, at, a.documentId);
    const docs = await fx.t.app.select().from(document).where(eq(document.entityId, v.encounterId));
    expect(docs.map((d) => [d.id === b.documentId, d.status, d.kind]).sort()).toEqual([
      [false, 'cancelled', 'rx_scan'],
      [true, 'active', 'rx_scan'],
    ]);
    expect(await key(scan(v.encounterId, at, a.documentId))).toBe('rx.scanNotFound');
  });

  it('ranks drugs by this doctor’s use, and finds orderable services only', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const before = await fx.run((tx) =>
      searchDrugs(tx, fx.f.facilityId, v.encounterId, { q: 'parac' }),
    );
    expect(before.length).toBeGreaterThan(1);
    expect(before.every((d) => /paracetamol/i.test(d.brandName))).toBe(true);
    // Earlier saves in this file prescribed Paracetamol 650 for doctor A: it comes first.
    expect(before[0]).toMatchObject({ id: ids.pcm650 });
    expect(before[0]!.uses).toBeGreaterThan(0);
    expect(
      await fx.run((tx) => searchDrugs(tx, fx.f.facilityId, v.encounterId, { q: '%' })),
    ).toEqual([]);

    const svcs = await searchOrderables(fx.t.app, fx.f.facilityId, 'cbc');
    expect(svcs.map((s) => [s.code, s.kind])).toContainEqual(['LAB-CBC', 'lab']);
    expect((await searchOrderables(fx.t.app, fx.f.facilityId, 'consultation')).length).toBe(0);
  });

  it('resolves the quick-tick list of the sheet to services', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const ctx = await fx.run((tx) => rxContext(tx, fx.f.facilityId, v.encounterId));
    const by = new Map(ctx.quickOrders.map((q) => [q.label, q.services.map((s) => s.kind)]));
    expect(by.get('CBC')).toEqual(['lab']);
    expect(by.get('HIV / HBsAg / VDRL')).toEqual(['lab', 'lab', 'lab']);
    expect(by.get('Obstetric USG')).toEqual(['usg']);
    expect(ctx.settings.requirePhoto).toBe(true);
  });

  it('repeats the last Rx of the same doctor for this patient', async () => {
    const at = nextDay()();
    const first = await seenVisit(at);
    const { documentId } = await scan(first.encounterId, at);
    await save(
      {
        encounterId: first.encounterId,
        scanDocumentId: documentId,
        items: [row(), row({ drugId: ids.folic, drugName: 'Folic acid 5 mg' })],
        orders: [],
      },
      at,
    );
    const next = nextDay()();
    const second = await seenVisit(next, first.patientId);
    const ctx = await fx.run((tx) => rxContext(tx, fx.f.facilityId, second.encounterId));
    expect(ctx.hasLastRx).toBe(true);
    const last = await fx.run((tx) => lastRxItems(tx, fx.f.facilityId, second.encounterId));
    expect(last!.items.map((i) => i.drugName)).toEqual(['Paracetamol 650 mg', 'Folic acid 5 mg']);
    expect(last!.items[0]!.genericName).toBe('Paracetamol');
  });
});

describe('doctor verification (Q15, docs/11 §2.7)', () => {
  it('lists the doctor’s own sampled Rx and verifies them; others cannot', async () => {
    await fx.t.owner
      .update(doctorProfile)
      .set({ userId: fx.f.userId })
      .where(eq(doctorProfile.id, fx.doctorA));
    try {
      const at = nextDay()();
      const v = await seenVisit(at);
      const { documentId } = await scan(v.encounterId, at);
      const r = await save(
        { encounterId: v.encounterId, scanDocumentId: documentId, items: [row()], orders: [] },
        at,
        0,
      );
      expect(r.needsVerification).toBe(true);
      const q = await fx.run((tx) => rxVerificationQueue(tx, fx.f.facilityId, fx.f.userId));
      const mine = q.find((x) => x.prescriptionId === r.prescriptionId)!;
      expect(mine).toMatchObject({ scanDocumentId: documentId, version: 1 });
      expect(mine.items).toHaveLength(1);

      const other = { facilityId: fx.f.facilityId, userId: uuidv7() };
      expect(await key(fx.run((tx) => verifyRx(tx, other, r.prescriptionId, at)))).toBe(
        'rx.notYourPatient',
      );
      await fx.run((tx) => verifyRx(tx, fx.actor(), r.prescriptionId, at));
      const [rx] = await fx.t.app
        .select()
        .from(prescription)
        .where(eq(prescription.id, r.prescriptionId));
      expect(rx).toMatchObject({ status: 'verified', verifiedBy: fx.f.userId });
      expect(await key(fx.run((tx) => verifyRx(tx, fx.actor(), r.prescriptionId, at)))).toBe(
        'rx.notPendingVerification',
      );
      const after = await fx.run((tx) => rxVerificationQueue(tx, fx.f.facilityId, fx.f.userId));
      expect(after.map((x) => x.prescriptionId)).not.toContain(r.prescriptionId);
    } finally {
      await fx.t.owner
        .update(doctorProfile)
        .set({ userId: null })
        .where(eq(doctorProfile.id, fx.doctorA));
    }
  });
});

describe('orders flow into billing (OPD-04, docs/12 §2)', () => {
  it('shows unbilled orders on the draft, adds priced ones, skips unpriced, bills on finalise', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const { documentId } = await scan(v.encounterId, at);
    await save(
      {
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [row()],
        orders: [{ serviceId: ids.cbc }, { serviceId: ids.hb }, { serviceId: ids.obUsg }],
        admission: { advised: true, expectedDate: null, note: null },
      },
      at,
    );
    const [draft] = await billsForEncounter(fx.t.app, fx.f.facilityId, v.encounterId);
    let view = (await getBillView(fx.t.app, fx.f.facilityId, draft!.id))!;
    // Admission advice is not billed from here; HB has no rate.
    expect(view.unbilledOrders.map((o) => [o.kind, o.ratePaise])).toEqual([
      ['lab', 30000n],
      ['lab', null],
      ['usg', 90000n],
    ]);
    const orderIds = view.unbilledOrders.map((o) => o.id);
    const res = await fx.run((tx) =>
      addOrdersToBill(
        tx,
        fx.actor(),
        { billId: draft!.id, orderIds, idempotencyKey: uuidv7() },
        at,
      ),
    );
    expect(res.added).toEqual([orderIds[0], orderIds[2]]);
    expect(res.skipped).toEqual([{ orderId: orderIds[1], reason: 'billing.noRate' }]);
    view = (await getBillView(fx.t.app, fx.f.facilityId, draft!.id))!;
    expect(view.unbilledOrders.map((o) => o.id)).toEqual([orderIds[1]]);
    // ₹500 consultation + ₹300 CBC + ₹900 USG.
    expect(view.netPaise).toBe(170000n);
    const usgLine = view.lines.find((l) => l.clinicalOrderId === orderIds[2])!;

    // Removing a line puts its order back on the unbilled list.
    await fx.run((tx) =>
      removeBillLine(
        tx,
        fx.actor(),
        { billId: draft!.id, lineId: usgLine.id, idempotencyKey: uuidv7() },
        at,
      ),
    );
    view = (await getBillView(fx.t.app, fx.f.facilityId, draft!.id))!;
    expect(view.unbilledOrders.map((o) => o.id).sort()).toEqual([orderIds[1], orderIds[2]].sort());

    // HB is cancelled in a correction and USG re-added; paying the bill finalises it.
    await save(
      {
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [row()],
        orders: [{ serviceId: ids.cbc }, { serviceId: ids.obUsg }],
        admission: { advised: true, expectedDate: null, note: null },
      },
      at,
    );
    await fx.run((tx) =>
      addOrdersToBill(
        tx,
        fx.actor(),
        { billId: draft!.id, orderIds: [orderIds[2]!], idempotencyKey: uuidv7() },
        at,
      ),
    );
    const due = (await fx.t.app.select().from(bill).where(eq(bill.id, draft!.id)))[0]!.balancePaise;
    await fx.run((tx) =>
      collectPayment(
        tx,
        fx.actor(),
        {
          billId: draft!.id,
          tenders: [{ mode: 'cash', amountPaise: due }],
          idempotencyKey: uuidv7(),
        },
        at,
        { mayFinalize: true },
      ),
    );
    const orders = await fx.t.app
      .select()
      .from(clinicalOrder)
      .where(eq(clinicalOrder.encounterId, v.encounterId));
    const st = (id: string) => orders.find((o) => o.id === id)!;
    expect(st(orderIds[0]!)).toMatchObject({ status: 'billed', billedAt: at });
    expect(st(orderIds[2]!).status).toBe('billed');
    expect(st(orderIds[1]!).status).toBe('cancelled');
    const lines = await fx.t.app.select().from(billLine).where(eq(billLine.billId, draft!.id));
    expect(lines.filter((l) => l.clinicalOrderId && l.status === 'active')).toHaveLength(2);
    const [tok] = await fx.t.app.select().from(opdToken).where(eq(opdToken.id, v.tokenId));
    expect(tok!.queueState).toBe('billed_orders');
  });

  it('does not move the token while an order is still unbilled', async () => {
    const at = nextDay()();
    const v = await seenVisit(at);
    const { documentId } = await scan(v.encounterId, at);
    await save(
      {
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [],
        orders: [{ serviceId: ids.cbc }, { serviceId: ids.tsh }],
      },
      at,
    );
    const [draft] = await billsForEncounter(fx.t.app, fx.f.facilityId, v.encounterId);
    const view = (await getBillView(fx.t.app, fx.f.facilityId, draft!.id))!;
    await fx.run((tx) =>
      addOrdersToBill(
        tx,
        fx.actor(),
        { billId: draft!.id, orderIds: [view.unbilledOrders[0]!.id], idempotencyKey: uuidv7() },
        at,
      ),
    );
    const due = (await fx.t.app.select().from(bill).where(eq(bill.id, draft!.id)))[0]!.balancePaise;
    await fx.run((tx) =>
      collectPayment(
        tx,
        fx.actor(),
        {
          billId: draft!.id,
          tenders: [{ mode: 'cash', amountPaise: due }],
          idempotencyKey: uuidv7(),
        },
        at,
        { mayFinalize: true },
      ),
    );
    const [tok] = await fx.t.app.select().from(opdToken).where(eq(opdToken.id, v.tokenId));
    expect(tok!.queueState).toBe('rx_entered');
    // A finalised bill takes no more lines; the remaining order waits for the next draft.
    const again = await fx
      .run((tx) =>
        finalizeBill(tx, fx.actor(), { billId: draft!.id, idempotencyKey: uuidv7() }, at),
      )
      .catch((e: Error) => e.message);
    expect(again).toBe('billing.notDraft');
  });
});
