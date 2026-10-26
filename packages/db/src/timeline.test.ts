import {
  createPregnancySchema,
  recordDoseSchema,
  saveAncVisitSchema,
  TIMELINE_ITEM_TYPES,
  type SaveRxInput,
  type TimelineItemType,
} from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bill, document, drug, encounter, patient, service } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { createPregnancy, saveAncVisit } from './anc';
import { billsForEncounter, collectPayment, finalizeBill } from './billing';
import { setServiceRate } from './masters';
import { recordDose } from './paeds';
import { attachRxScan, saveRx } from './rx';
import { getTimeline, TimelineInputError, type TimelineItem, type TimelinePage } from './timeline';
import { issueToken } from './visits';
import { markSeen, sendIn } from './queue';

let fx: OpdFixture;
let day = 0;
const ALL: readonly TimelineItemType[] = TIMELINE_ITEM_TYPES;
const MARKER = 'MTPMARKER';
let drugId: string;
let cbcId: string;

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  [{ id: drugId }] = (await fx.t.app
    .select({ id: drug.id })
    .from(drug)
    .where(eq(drug.facilityId, fx.f.facilityId))
    .limit(1)) as [{ id: string }];
  [{ id: cbcId }] = (await fx.t.app
    .select({ id: service.id })
    .from(service)
    .where(and(eq(service.facilityId, fx.f.facilityId), eq(service.code, 'LAB-CBC')))) as [
    { id: string },
  ];
  await fx.run((tx) =>
    setServiceRate(tx, {
      facilityId: fx.f.facilityId,
      serviceId: cbcId,
      tariffId: fx.m.defaultTariffId,
      ratePaise: 30000n,
      effectiveFrom: '2026-01-01',
    }),
  );
});
afterAll(async () => {
  await fx.t.close();
});

const actor = (types: readonly TimelineItemType[] = ALL) => ({
  facilityId: fx.f.facilityId,
  types,
});
const page = (
  patientId: string,
  over: Partial<Parameters<typeof getTimeline>[2]> = {},
  types = ALL,
) => fx.run((tx) => getTimeline(tx, actor(types), { patientId, limit: 50, ...over }));
const nextDay = () => {
  day += 1;
  return (hh = '10') => IST(`2028-06-${String(day).padStart(2, '0')}T${hh}:00:00`);
};

let fileN = 0;
/** A seen visit with a photo, a prescription (`withMarker` names its drug), an order and a bill. */
async function fullVisit(patientId: string, at: Date, opts: { final?: boolean } = {}) {
  const v = await fx.visit({ patientId, doctorId: fx.doctorA }, at);
  const tok = v.tokenId
    ? { tokenId: v.tokenId }
    : await fx.run((tx) => issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', at));
  await fx.run((tx) => sendIn(tx, fx.actor(), tok.tokenId, at));
  await fx.run((tx) => markSeen(tx, fx.actor(), tok.tokenId, at));
  const { documentId } = await fx.run((tx) =>
    attachRxScan(
      tx,
      fx.actor(),
      {
        encounterId: v.encounterId,
        replacesDocumentId: null,
        file: {
          relPath: `${fx.f.facilityId}/2028/06/${uuidv7()}.jpg`,
          sizeBytes: 1000 + fileN++,
          sha256: 'b'.repeat(64),
        },
      },
      at,
    ),
  );
  const item: SaveRxInput['items'][number] = {
    drugId,
    drugName: `${MARKER} 500 mg`,
    form: 'tab',
    doseText: null,
    frequencyCode: null,
    pattern: '1-0-1',
    timing: 'af',
    route: null,
    durationValue: 3,
    durationUnit: 'd',
    quantity: null,
    instructionsEn: null,
    instructionsHi: null,
    sourceLine: null,
  };
  const rx = await fx.run((tx) =>
    saveRx(
      tx,
      fx.actor(),
      {
        idempotencyKey: uuidv7(),
        encounterId: v.encounterId,
        scanDocumentId: documentId,
        items: [item],
        orders: [{ serviceId: cbcId }],
      },
      at,
      () => 0.99,
    ),
  );
  if (opts.final) {
    const [draft] = await billsForEncounter(fx.t.app, fx.f.facilityId, v.encounterId);
    const pay = (b: { id: string; balancePaise: bigint }) =>
      b.balancePaise > 0n
        ? fx.run((tx) =>
            collectPayment(
              tx,
              fx.actor(),
              {
                billId: b.id,
                tenders: [{ mode: 'cash', amountPaise: b.balancePaise }],
                idempotencyKey: uuidv7(),
              },
              at,
              { mayFinalize: true },
            ),
          )
        : fx.run((tx) =>
            finalizeBill(tx, fx.actor(), { billId: b.id, idempotencyKey: uuidv7() }, at),
          );
    await pay(draft!);
  }
  return { ...v, documentId, prescriptionId: rx.prescriptionId };
}

const restrict = (encounterId: string) =>
  fx.t.owner.update(encounter).set({ isRestricted: true }).where(eq(encounter.id, encounterId));
const ids = (items: TimelineItem[]) => items.map((i) => i.id);
async function walk(patientId: string, limit: number, types = ALL) {
  const out: TimelineItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p: TimelinePage = await page(patientId, { limit, cursor }, types);
    out.push(...p.items);
    cursor = p.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  return { out, pages };
}

describe('patient timeline (OPD-07, docs/11 §2.8)', () => {
  it('lists visits with vitals-less summary, Rx rows, orders, bills and photos, newest first', async () => {
    const pid = await fx.newPatient();
    const a = await fullVisit(pid, nextDay()('09'), { final: true });
    const b = await fullVisit(pid, nextDay()('09'));
    const p = await page(pid);
    const visits = p.items.filter((i) => i.type === 'visit');
    expect(visits.map((v) => v.id)).toEqual([b.encounterId, a.encounterId]);
    expect(visits[0]).toMatchObject({ status: 'open', vitals: null });
    const rx = p.items.filter((i) => i.type === 'rx');
    expect(rx).toHaveLength(2);
    expect(rx[0]).toMatchObject({ items: [{ drugName: `${MARKER} 500 mg`, durationUnit: 'd' }] });
    expect(p.items.filter((i) => i.type === 'order')).toHaveLength(2);
    const bills = p.items.filter((i) => i.type === 'bill');
    // Only the finalised bill; the other is still a draft.
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ encounterId: a.encounterId, status: 'final' });
    expect(typeof (bills[0] as { netPaise: bigint }).netPaise).toBe('bigint');
    expect(p.items.filter((i) => i.type === 'document').map((d) => d.id)).toEqual(
      expect.arrayContaining([a.documentId, b.documentId]),
    );
    const sorted = [...p.items].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
    expect(p.items.map((i) => i.at)).toEqual(sorted.map((i) => i.at));
    expect(p.nextCursor).toBeNull();
  });

  it('pages by cursor without gaps or repeats, including items with the same instant', async () => {
    const pid = await fx.newPatient();
    for (let i = 0; i < 3; i++) await fullVisit(pid, nextDay()('11'), { final: i === 0 });
    // Two documents stamped with the very same instant as one another.
    const stamp = new Date('2028-06-05T05:30:00.123456Z');
    for (let n = 0; n < 3; n++) {
      const id = uuidv7();
      await fx.t.owner.insert(document).values({
        id,
        facilityId: fx.f.facilityId,
        kind: 'photo',
        entity: 'patient',
        entityId: pid,
        filePath: `${fx.f.facilityId}/2028/06/${id}.jpg`,
        mime: 'image/jpeg',
        sizeBytes: 10,
        sha256: 'd'.repeat(64),
        createdAt: stamp,
      });
    }
    const all = await page(pid);
    for (const limit of [1, 2, 3, 5]) {
      const { out } = await walk(pid, limit);
      expect(ids(out), `limit ${limit}`).toEqual(ids(all.items));
      expect(new Set(out.map((i) => i.key)).size).toBe(out.length);
    }
    const first = await page(pid, { limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const last = await page(pid, { limit: all.items.length });
    expect(last.nextCursor).toBeNull();
  });

  it('shows only the kinds the caller may see, and `types` narrows further', async () => {
    const pid = await fx.newPatient();
    await fullVisit(pid, nextDay()('12'), { final: true });
    const visitsOnly = await page(pid, {}, ['visit']);
    expect(new Set(visitsOnly.items.map((i) => i.type))).toEqual(new Set(['visit']));
    const noBills = await page(pid, {}, ['visit', 'rx']);
    expect(noBills.items.some((i) => i.type === 'bill' || i.type === 'order')).toBe(false);
    const narrowed = await page(pid, { types: ['rx', 'bill'] });
    expect(new Set(narrowed.items.map((i) => i.type))).toEqual(new Set(['rx', 'bill']));
    // Asking for a kind that is not permitted returns nothing, not an error or a leak.
    const denied = await page(pid, { types: ['bill'] }, ['visit']);
    expect(denied.items).toEqual([]);
  });

  it('never returns restricted (MTP) data, even with every kind permitted', async () => {
    const pid = await fx.newPatient();
    await fx.t.owner.update(patient).set({ dob: '1998-05-05' }).where(eq(patient.id, pid));
    const normal = await fullVisit(pid, nextDay()('09'), { final: true });
    const mtp = await fullVisit(pid, nextDay()('09'), { final: true });
    const [mtpBill] = await fx.t.app
      .select()
      .from(bill)
      .where(eq(bill.encounterId, mtp.encounterId));

    // An ANC visit and a document attached to the restricted encounter, a Form F scan, a
    // document on an unknown entity, and one that belongs to the patient (shown).
    const now = IST('2028-06-28T10:00:00');
    const preg = await fx.run((tx) =>
      createPregnancy(
        tx,
        { ...fx.actor(), mtp: { view: false, edit: false } },
        createPregnancySchema.parse({
          patientId: pid,
          idempotencyKey: uuidv7(),
          lmp: '2028-04-20',
        }),
        now,
      ),
    );
    const ancVisit = (encounterId: string | null, visitDate: string) =>
      fx.run((tx) =>
        saveAncVisit(
          tx,
          { ...fx.actor(), mtp: { view: false, edit: false } },
          saveAncVisitSchema.parse({ pregnancyId: preg.pregnancyId, encounterId, visitDate }),
          now,
        ),
      );
    const ancOk = await ancVisit(null, '2028-06-10');
    const ancMtp = await ancVisit(mtp.encounterId, '2028-06-12');
    const doc = async (kind: string, entity: string | null, entityId: string | null) => {
      const id = uuidv7();
      await fx.t.owner.insert(document).values({
        id,
        facilityId: fx.f.facilityId,
        kind,
        entity,
        entityId,
        filePath: `${fx.f.facilityId}/2028/06/${id}.pdf`,
        mime: 'application/pdf',
        sizeBytes: 10,
        sha256: 'c'.repeat(64),
      });
      return id;
    };
    const dMtp = await doc('report_pdf', 'encounter', mtp.encounterId);
    const dFormF = await doc('form_f_signed', 'encounter', normal.encounterId);
    const dFormFPatient = await doc('form_f_signed', 'patient', pid);
    const dCase = await doc('consent', 'mtp_case', uuidv7());
    const dPatient = await doc('photo', 'patient', pid);
    const dOther = await doc('photo', 'patient', await fx.newPatient());

    // Flip the visit to restricted after everything is on it (as the MTP admission would be).
    await restrict(mtp.encounterId);

    const before = JSON.stringify(
      await Promise.all([page(pid), walk(pid, 1).then((w) => w.out)]),
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    const p = await page(pid);
    const got = new Set(ids(p.items));
    // Shown: the normal visit's records, the unrestricted ANC visit, the patient's own photo.
    for (const id of [
      normal.encounterId,
      normal.prescriptionId,
      normal.documentId,
      ancOk.visitId,
      dPatient,
    ]) {
      expect(got.has(id), id).toBe(true);
    }
    // Hidden: everything of the restricted visit, Form F scans, unknown attachment points,
    // and other patients' documents.
    const hidden = [
      mtp.encounterId,
      mtp.prescriptionId,
      mtp.documentId,
      mtpBill!.id,
      ancMtp.visitId,
      dMtp,
      dFormF,
      dFormFPatient,
      dCase,
      dOther,
    ];
    for (const id of hidden) expect(before.includes(id), id).toBe(false);
    expect(p.items.some((i) => i.type === 'order' && i.encounterId === mtp.encounterId)).toBe(
      false,
    );
    expect(p.items.some((i) => i.type === 'bill' && i.encounterId === mtp.encounterId)).toBe(false);
    expect(p.items.filter((i) => i.type === 'rx')).toHaveLength(1);
    // Narrowing to one kind does not bring it back either.
    for (const t of ALL) {
      const only = await page(pid, { types: [t] });
      expect(
        only.items.some((i) => hidden.includes(i.id)),
        t,
      ).toBe(false);
    }
  });

  it('leaves out a vaccine dose given at a restricted encounter', async () => {
    const pid = await fx.newPatient();
    await fx.t.owner
      .update(patient)
      .set({ dob: '2028-06-01', sex: 'F' })
      .where(eq(patient.id, pid));
    const at = IST('2028-06-20T10:00:00');
    const dose = (itemCode: string, encounterId: string | null) =>
      fx.run((tx) =>
        recordDose(
          tx,
          fx.actor(),
          recordDoseSchema.parse({
            idempotencyKey: uuidv7(),
            patientId: pid,
            itemCode,
            vaccineName: itemCode,
            batchNo: 'B-1',
            expiry: '2029-12-31',
            site: 'left_thigh',
            route: 'im',
            givenOn: '2028-06-20',
            encounterId,
          }),
          at,
        ),
      );
    const v = await fx.visit({ patientId: pid, doctorId: fx.doctorA }, at);
    const open = await dose('BCG-1', null);
    const hidden = await dose('OPV-1', v.encounterId);
    await restrict(v.encounterId);
    const p = await page(pid);
    expect(p.items.filter((i) => i.type === 'vaccine').map((i) => i.id)).toEqual([open.givenId]);
    expect(ids(p.items)).not.toContain(hidden.givenId);
    expect(ids(p.items)).not.toContain(v.encounterId);
  });

  it('rejects an unknown patient and a made-up cursor', async () => {
    const key = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e instanceof TimelineInputError ? e.key : String(e)),
      );
    expect(await key(page(uuidv7()))).toBe('timeline.patientNotFound');
    const pid = await fx.newPatient();
    expect(await key(page(pid, { cursor: 'not-a-cursor' }))).toBe('timeline.badCursor');
    expect(await key(page(pid, { cursor: btoa('2028-01-01|x') }))).toBe('timeline.badCursor');
  });
});
