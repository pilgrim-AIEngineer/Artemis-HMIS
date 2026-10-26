/**
 * Patient timeline (OPD-07, docs/11 §2.8): visits, prescriptions, orders, bills, ANC visits,
 * vaccine doses and documents of one patient, newest first, paged by an opaque cursor.
 *
 * Restricted (MTP) data never appears, whatever the caller may see elsewhere (AGENTS.md rule 8,
 * docs/03 §5, docs/14): every item that hangs off an `is_restricted` encounter is left out, no
 * `restricted.*` table is read, and documents are taken only from an allow-list of attachment
 * points (the patient, or an unrestricted encounter) with Form F scans excluded. Which kinds of
 * item the caller sees is decided by the router (`visibleTimelineTypes`); a kind that is not in
 * `types` is not even queried. Nothing here describes a fetus (AGENTS.md rule 7).
 *
 * Paging: each kind is read newest-first below the cursor `(at, id)`, `limit + 1` rows at most,
 * and the kinds are merged. Instants travel as fixed-width UTC text with microseconds, so the
 * cursor loses no precision and equal instants are ordered by id.
 */
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  TIMELINE_ITEM_TYPES,
  type TimelineCursor,
  type TimelineItemType,
} from '@hmis/shared';
import { and, desc, eq, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  ancVisit,
  bill,
  clinicalOrder,
  doctorProfile,
  document,
  encounter,
  immunisationGiven,
  labTest,
  patient,
  pregnancy,
  prescription,
  prescriptionItem,
  service,
  usgProcedure,
  vitals,
} from '../schema';
import type { Db } from './client';
import type { Tx } from './tx';

type Queryable = Db | Tx;

export type TimelineErrorKey = 'timeline.patientNotFound' | 'timeline.badCursor';

export class TimelineInputError extends Error {
  constructor(readonly key: TimelineErrorKey) {
    super(key);
    this.name = 'TimelineInputError';
  }
}

export interface TimelineActor {
  facilityId: string;
  /** Kinds of item the caller may see (`visibleTimelineTypes`). */
  types: readonly TimelineItemType[];
}

export interface TimelineVitalsSummary {
  bpSys: number | null;
  bpDia: number | null;
  pulse: number | null;
  tempC: string | null;
  spo2: number | null;
  weightKg: string | null;
}

export interface TimelineRxRow {
  drugName: string;
  doseText: string | null;
  pattern: string | null;
  durationValue: number | null;
  durationUnit: string | null;
}

interface Base {
  /** `type:id`, unique in the list. */
  key: string;
  id: string;
  /** Fixed-width UTC instant, `2026-10-26T04:30:00.000000Z`. */
  at: string;
}

export type TimelineItem = Base &
  (
    | {
        type: 'visit';
        number: string;
        visitType: string;
        status: string;
        doctorName: string;
        encounterId: string;
        vitals: TimelineVitalsSummary | null;
      }
    | {
        type: 'rx';
        encounterId: string;
        status: string;
        version: number;
        doctorName: string;
        verified: boolean;
        items: TimelineRxRow[];
      }
    | {
        type: 'order';
        encounterId: string;
        kind: string;
        name: string | null;
        status: string;
        priority: string;
      }
    | {
        type: 'bill';
        encounterId: string;
        number: string | null;
        kind: string;
        status: string;
        netPaise: bigint;
        paidPaise: bigint;
        balancePaise: bigint;
      }
    | {
        type: 'anc';
        visitDate: string;
        gaDays: number;
        weightKg: string | null;
        bpSys: number | null;
        bpDia: number | null;
        hb: string | null;
      }
    | {
        type: 'vaccine';
        itemCode: string | null;
        vaccineName: string;
        batchNo: string;
        givenOn: string;
      }
    | {
        type: 'document';
        kind: string;
        mime: string;
        encounterId: string | null;
        pages: number | null;
      }
  );

export interface TimelinePage {
  items: TimelineItem[];
  /** Null when nothing older is left. */
  nextCursor: string | null;
}

const IST_MIDNIGHT = (d: SQL) => sql`(${d}::timestamp at time zone 'Asia/Kolkata')`;
const atText = (expr: SQL) =>
  sql<string>`to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const before = (at: SQL, id: SQL, c: TimelineCursor | null): SQL | undefined =>
  c ? sql`(${at}, ${id}) < (${c.at}::timestamptz, ${c.id}::uuid)` : undefined;

const notRestricted = sql`${encounter.isRestricted} = false`;
const num = (v: string | null): string | null => v;

interface Ctx {
  q: Queryable;
  facilityId: string;
  patientId: string;
  cursor: TimelineCursor | null;
  take: number;
}

async function visits(c: Ctx): Promise<TimelineItem[]> {
  const at = sql`${encounter.startedAt}`;
  const rows = await c.q
    .select({
      id: encounter.id,
      at: atText(at),
      number: encounter.number,
      visitType: encounter.visitType,
      status: encounter.status,
      doctorName: doctorProfile.displayName,
    })
    .from(encounter)
    .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .where(
      and(
        eq(encounter.facilityId, c.facilityId),
        eq(encounter.patientId, c.patientId),
        notRestricted,
        before(at, sql`${encounter.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(encounter.id))
    .limit(c.take);
  const ids = rows.map((r) => r.id);
  const vit = ids.length
    ? await c.q
        .select({
          encounterId: vitals.encounterId,
          bpSys: vitals.bpSys,
          bpDia: vitals.bpDia,
          pulse: vitals.pulse,
          tempC: vitals.tempC,
          spo2: vitals.spo2,
          weightKg: vitals.weightKg,
        })
        .from(vitals)
        .where(and(inArray(vitals.encounterId, ids), eq(vitals.status, 'active')))
    : [];
  const byEncounter = new Map(vit.map((v) => [v.encounterId, v]));
  return rows.map((r) => {
    const v = byEncounter.get(r.id);
    return {
      type: 'visit' as const,
      key: `visit:${r.id}`,
      id: r.id,
      at: r.at,
      encounterId: r.id,
      number: r.number,
      visitType: r.visitType,
      status: r.status,
      doctorName: r.doctorName,
      vitals: v
        ? {
            bpSys: v.bpSys,
            bpDia: v.bpDia,
            pulse: v.pulse,
            tempC: num(v.tempC),
            spo2: v.spo2,
            weightKg: num(v.weightKg),
          }
        : null,
    };
  });
}

async function prescriptions(c: Ctx): Promise<TimelineItem[]> {
  const at = sql`${prescription.enteredAt}`;
  const rows = await c.q
    .select({
      id: prescription.id,
      at: atText(at),
      encounterId: prescription.encounterId,
      status: prescription.status,
      version: prescription.version,
      doctorName: doctorProfile.displayName,
    })
    .from(prescription)
    .innerJoin(encounter, eq(encounter.id, prescription.encounterId))
    .innerJoin(doctorProfile, eq(doctorProfile.id, prescription.doctorId))
    .where(
      and(
        eq(prescription.facilityId, c.facilityId),
        eq(prescription.patientId, c.patientId),
        inArray(prescription.status, ['final', 'verified']),
        notRestricted,
        before(at, sql`${prescription.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(prescription.id))
    .limit(c.take);
  const ids = rows.map((r) => r.id);
  const lines = ids.length
    ? await c.q
        .select({
          prescriptionId: prescriptionItem.prescriptionId,
          seq: prescriptionItem.seq,
          drugName: prescriptionItem.drugName,
          doseText: prescriptionItem.doseText,
          pattern: prescriptionItem.pattern,
          durationValue: prescriptionItem.durationValue,
          durationUnit: prescriptionItem.durationUnit,
        })
        .from(prescriptionItem)
        .where(inArray(prescriptionItem.prescriptionId, ids))
        .orderBy(prescriptionItem.prescriptionId, prescriptionItem.seq)
    : [];
  return rows.map((r) => ({
    type: 'rx' as const,
    key: `rx:${r.id}`,
    id: r.id,
    at: r.at,
    encounterId: r.encounterId,
    status: r.status,
    version: r.version,
    doctorName: r.doctorName,
    verified: r.status === 'verified',
    items: lines
      .filter((l) => l.prescriptionId === r.id)
      .map(({ drugName, doseText, pattern, durationValue, durationUnit }) => ({
        drugName,
        doseText,
        pattern,
        durationValue,
        durationUnit,
      })),
  }));
}

async function orders(c: Ctx): Promise<TimelineItem[]> {
  const at = sql`${clinicalOrder.createdAt}`;
  const rows = await c.q
    .select({
      id: clinicalOrder.id,
      at: atText(at),
      encounterId: clinicalOrder.encounterId,
      kind: clinicalOrder.kind,
      status: clinicalOrder.status,
      priority: clinicalOrder.priority,
      name: sql<string | null>`coalesce(${service.name}, ${labTest.name}, ${usgProcedure.name})`,
    })
    .from(clinicalOrder)
    .innerJoin(encounter, eq(encounter.id, clinicalOrder.encounterId))
    .leftJoin(service, eq(service.id, clinicalOrder.serviceId))
    .leftJoin(labTest, eq(labTest.id, clinicalOrder.labTestId))
    .leftJoin(usgProcedure, eq(usgProcedure.id, clinicalOrder.usgProcedureId))
    .where(
      and(
        eq(clinicalOrder.facilityId, c.facilityId),
        eq(clinicalOrder.patientId, c.patientId),
        notRestricted,
        before(at, sql`${clinicalOrder.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(clinicalOrder.id))
    .limit(c.take);
  return rows.map((r) => ({ type: 'order' as const, key: `order:${r.id}`, ...r }));
}

async function bills(c: Ctx): Promise<TimelineItem[]> {
  const at = sql`${bill.finalizedAt}`;
  const rows = await c.q
    .select({
      id: bill.id,
      at: atText(at),
      encounterId: bill.encounterId,
      number: bill.number,
      kind: bill.kind,
      status: bill.status,
      netPaise: bill.netPaise,
      paidPaise: bill.paidPaise,
      balancePaise: bill.balancePaise,
    })
    .from(bill)
    .innerJoin(encounter, eq(encounter.id, bill.encounterId))
    .where(
      and(
        eq(bill.facilityId, c.facilityId),
        eq(bill.patientId, c.patientId),
        // A draft has no number and is still being made; it is not a record yet.
        ne(bill.status, 'draft'),
        isNotNull(bill.finalizedAt),
        notRestricted,
        before(at, sql`${bill.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(bill.id))
    .limit(c.take);
  return rows.map((r) => ({ type: 'bill' as const, key: `bill:${r.id}`, ...r }));
}

async function ancVisits(c: Ctx): Promise<TimelineItem[]> {
  const at = IST_MIDNIGHT(sql`${ancVisit.visitDate}`);
  const rows = await c.q
    .select({
      id: ancVisit.id,
      at: atText(at),
      visitDate: ancVisit.visitDate,
      gaDays: ancVisit.gaDays,
      weightKg: ancVisit.weightKg,
      bpSys: ancVisit.bpSys,
      bpDia: ancVisit.bpDia,
      hb: ancVisit.hb,
    })
    .from(ancVisit)
    .innerJoin(pregnancy, eq(pregnancy.id, ancVisit.pregnancyId))
    .leftJoin(encounter, eq(encounter.id, ancVisit.encounterId))
    .where(
      and(
        eq(ancVisit.facilityId, c.facilityId),
        eq(pregnancy.patientId, c.patientId),
        eq(ancVisit.status, 'active'),
        sql`coalesce(${encounter.isRestricted}, false) = false`,
        before(at, sql`${ancVisit.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(ancVisit.id))
    .limit(c.take);
  return rows.map((r) => ({ type: 'anc' as const, key: `anc:${r.id}`, ...r }));
}

async function vaccines(c: Ctx): Promise<TimelineItem[]> {
  const at = IST_MIDNIGHT(sql`${immunisationGiven.givenOn}`);
  const rows = await c.q
    .select({
      id: immunisationGiven.id,
      at: atText(at),
      itemCode: immunisationGiven.itemCode,
      vaccineName: immunisationGiven.vaccineName,
      batchNo: immunisationGiven.batchNo,
      givenOn: immunisationGiven.givenOn,
    })
    .from(immunisationGiven)
    .leftJoin(encounter, eq(encounter.id, immunisationGiven.encounterId))
    .where(
      and(
        eq(immunisationGiven.facilityId, c.facilityId),
        eq(immunisationGiven.patientId, c.patientId),
        eq(immunisationGiven.status, 'active'),
        sql`coalesce(${encounter.isRestricted}, false) = false`,
        before(at, sql`${immunisationGiven.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(immunisationGiven.id))
    .limit(c.take);
  return rows.map((r) => ({ type: 'vaccine' as const, key: `vaccine:${r.id}`, ...r }));
}

async function documents(c: Ctx): Promise<TimelineItem[]> {
  const at = sql`${document.createdAt}`;
  const rows = await c.q
    .select({
      id: document.id,
      at: atText(at),
      kind: document.kind,
      mime: document.mime,
      pages: document.pages,
      entity: document.entity,
      encounterId: encounter.id,
    })
    .from(document)
    .leftJoin(encounter, and(eq(document.entity, 'encounter'), eq(encounter.id, document.entityId)))
    .where(
      and(
        eq(document.facilityId, c.facilityId),
        eq(document.status, 'active'),
        // Form F scans belong to the PCPNDT register, not to the patient's story.
        ne(document.kind, 'form_f_signed'),
        // Allow-list of attachment points: anything else (MTP cases, registers) is left out.
        or(
          and(eq(document.entity, 'patient'), eq(document.entityId, c.patientId)),
          and(
            eq(document.entity, 'encounter'),
            eq(encounter.patientId, c.patientId),
            notRestricted,
          ),
        ),
        before(at, sql`${document.id}`, c.cursor),
      ),
    )
    .orderBy(desc(at), desc(document.id))
    .limit(c.take);
  return rows.map((r) => ({
    type: 'document' as const,
    key: `document:${r.id}`,
    id: r.id,
    at: r.at,
    kind: r.kind,
    mime: r.mime,
    pages: r.pages,
    encounterId: r.encounterId,
  }));
}

const READERS: Record<TimelineItemType, (c: Ctx) => Promise<TimelineItem[]>> = {
  visit: visits,
  rx: prescriptions,
  order: orders,
  bill: bills,
  anc: ancVisits,
  vaccine: vaccines,
  document: documents,
};

export interface TimelineQuery {
  patientId: string;
  cursor?: string | null;
  limit: number;
  /** Narrows to these kinds (still only those the caller may see). */
  types?: readonly TimelineItemType[] | undefined;
}

export async function getTimeline(
  q: Queryable,
  actor: TimelineActor,
  input: TimelineQuery,
): Promise<TimelinePage> {
  const [p] = await q
    .select({ id: patient.id, status: patient.status })
    .from(patient)
    .where(and(eq(patient.id, input.patientId), eq(patient.facilityId, actor.facilityId)));
  if (!p || p.status === 'cancelled') throw new TimelineInputError('timeline.patientNotFound');

  const cursor = input.cursor ? decodeTimelineCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw new TimelineInputError('timeline.badCursor');

  const wanted = TIMELINE_ITEM_TYPES.filter(
    (t) => actor.types.includes(t) && (!input.types || input.types.includes(t)),
  );
  const ctx: Ctx = {
    q,
    facilityId: actor.facilityId,
    patientId: input.patientId,
    cursor,
    take: input.limit + 1,
  };
  const merged: TimelineItem[] = [];
  for (const t of wanted) merged.push(...(await READERS[t](ctx)));
  merged.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));

  const items = merged.slice(0, input.limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      merged.length > input.limit && last
        ? encodeTimelineCursor({ at: last.at, id: last.id })
        : null,
  };
}
