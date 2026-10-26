/**
 * Rx transcription (OPD-02 … OPD-04, docs/11 §2): the assistant's worklist, the screen context,
 * drug and order search, the autosaved draft, the paper photo, and saving the transcription with
 * its orders, note and follow-up in one transaction. A correction never overwrites (AGENTS.md
 * rule 4): it inserts the next prescription version and marks the old one `superseded`; orders
 * that are no longer wanted are cancelled with a reason, and an order already on a bill cannot be
 * dropped from here (billing removes it first).
 *
 * Restricted (MTP) encounters are not handled here at all (AGENTS.md rule 8): they are left out of
 * the worklist and every call on one answers "not found".
 */
import { randomInt } from 'node:crypto';
import {
  buildInstruction,
  canTransition,
  DEFAULT_QUICK_ORDERS,
  isOrderableCategory,
  isValidFollowUpDate,
  istDateString,
  MAX_QUICK_ORDERS_ON_SHEET,
  needsVerification,
  ORDERABLE_CATEGORIES,
  rxQuantity,
  rxWarnings,
  saveRxSchema,
  searchQueryText,
  type DrugForm,
  type DurationUnit,
  type FrequencyCode,
  type OrderKind,
  type OrderStatus,
  type QueueState,
  type RxDraftPayload,
  type RxItem,
  type RxRoute,
  type RxStatus,
  type RxTiming,
  type RxWarning,
  type SaveRxInput,
} from '@hmis/shared';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  appUser,
  clinicalNote,
  clinicalOrder,
  doctorProfile,
  document,
  drug,
  encounter,
  opdToken,
  patient,
  prescription,
  prescriptionItem,
  rxDraft,
  service,
  vitals,
} from '../schema';
import type { Db } from './client';
import { runIdempotent } from './idempotency';
import { advanceToken } from './queue';
import { readSettings } from './settings';
import type { Tx } from './tx';

type Queryable = Db | Tx;

export type RxErrorKey =
  | 'rx.encounterNotFound'
  | 'rx.encounterNotOpen'
  | 'rx.photoRequired'
  | 'rx.scanNotFound'
  | 'rx.empty'
  | 'rx.drugNotFound'
  | 'rx.orderNotOrderable'
  | 'rx.orderBilled'
  | 'rx.followUpInvalid'
  | 'rx.admissionDateInvalid'
  | 'rx.notFound'
  | 'rx.notPendingVerification'
  | 'rx.notYourPatient';

/** Input / state errors the router turns into i18n keys (docs/02 §7). */
export class RxInputError extends Error {
  constructor(readonly key: RxErrorKey) {
    super(key);
    this.name = 'RxInputError';
  }
}

export interface RxActor {
  facilityId: string;
  userId: string;
}

/** Token states whose patient the doctor has seen (or is seeing): the "to transcribe" list. */
const SEEN_STATES: readonly QueueState[] = ['with_doctor', 'seen'];
const CURRENT_RX: readonly RxStatus[] = ['final', 'verified'];

// ---------------------------------------------------------------- encounter guard

interface EncounterRow {
  id: string;
  patientId: string;
  doctorId: string;
  status: string;
  visitDate: string;
  visitType: string;
  number: string;
}

/** The OPD encounter of the facility, refusing restricted ones; `lock` takes a row lock. */
async function loadEncounter(
  q: Queryable,
  facilityId: string,
  encounterId: string,
  lock = false,
): Promise<EncounterRow> {
  const qb = q
    .select({
      id: encounter.id,
      patientId: encounter.patientId,
      doctorId: encounter.doctorId,
      status: encounter.status,
      visitDate: encounter.visitDate,
      visitType: encounter.visitType,
      number: encounter.number,
      type: encounter.type,
      isRestricted: encounter.isRestricted,
    })
    .from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.facilityId, facilityId)));
  const [row] = lock ? await qb.for('update') : await qb;
  if (!row || row.type !== 'opd' || row.isRestricted) {
    throw new RxInputError('rx.encounterNotFound');
  }
  return row;
}

const requireOpen = (e: EncounterRow) => {
  if (e.status !== 'open') throw new RxInputError('rx.encounterNotOpen');
};

// ---------------------------------------------------------------- worklist

export interface TranscriptionItem {
  encounterId: string;
  tokenId: string;
  tokenNo: number;
  queueState: QueueState;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  dob: string;
  sex: string;
  doctor: { displayName: string; displayNameHi: string | null };
  seenAt: Date | null;
  rx: { version: number; status: RxStatus; needsVerification: boolean; enteredAt: Date } | null;
}

export interface TranscriptionList {
  date: string;
  /** Seen by the doctor, no Rx typed yet: oldest first. */
  toTranscribe: TranscriptionItem[];
  /** Typed today (open for corrections): latest first. */
  transcribed: TranscriptionItem[];
}

/** The assistant's list for today (docs/11 §2.1, "Seen — to transcribe"). */
export async function transcriptionList(
  q: Queryable,
  facilityId: string,
  now: Date,
): Promise<TranscriptionList> {
  const date = istDateString(now);
  const rows = await q
    .select({
      encounterId: opdToken.encounterId,
      tokenId: opdToken.id,
      tokenNo: opdToken.tokenNo,
      queueState: opdToken.queueState,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      doctorName: doctorProfile.displayName,
      doctorNameHi: doctorProfile.displayNameHi,
      seenAt: opdToken.seenAt,
      calledAt: opdToken.calledAt,
      rxVersion: prescription.version,
      rxStatus: prescription.status,
      rxVerify: prescription.needsVerification,
      rxAt: prescription.enteredAt,
    })
    .from(opdToken)
    .innerJoin(encounter, eq(encounter.id, opdToken.encounterId))
    .innerJoin(patient, eq(patient.id, encounter.patientId))
    .innerJoin(doctorProfile, eq(doctorProfile.id, opdToken.doctorId))
    .leftJoin(
      prescription,
      and(
        eq(prescription.encounterId, opdToken.encounterId),
        inArray(prescription.status, [...CURRENT_RX]),
      ),
    )
    .where(
      and(
        eq(opdToken.facilityId, facilityId),
        eq(opdToken.tokenDate, date),
        eq(encounter.isRestricted, false),
        eq(encounter.status, 'open'),
        ne(opdToken.queueState, 'cancelled'),
      ),
    );
  const items = rows.map((r): TranscriptionItem & { calledAt: Date | null } => ({
    encounterId: r.encounterId,
    tokenId: r.tokenId,
    tokenNo: r.tokenNo,
    queueState: r.queueState as QueueState,
    uhid: r.uhid,
    fullName: r.fullName,
    nameHi: r.nameHi,
    dob: r.dob,
    sex: r.sex,
    doctor: { displayName: r.doctorName, displayNameHi: r.doctorNameHi },
    seenAt: r.seenAt,
    calledAt: r.calledAt,
    rx:
      r.rxVersion === null
        ? null
        : {
            version: r.rxVersion,
            status: r.rxStatus as RxStatus,
            needsVerification: r.rxVerify!,
            enteredAt: r.rxAt!,
          },
  }));
  const strip = ({ calledAt: _c, ...i }: TranscriptionItem & { calledAt: Date | null }) => i;
  const seenTime = (i: { seenAt: Date | null; calledAt: Date | null }) =>
    (i.seenAt ?? i.calledAt)?.getTime() ?? 0;
  return {
    date,
    toTranscribe: items
      .filter((i) => !i.rx && SEEN_STATES.includes(i.queueState))
      .sort((a, b) => seenTime(a) - seenTime(b) || a.tokenNo - b.tokenNo)
      .map(strip),
    transcribed: items
      .filter((i) => i.rx)
      .sort((a, b) => b.rx!.enteredAt.getTime() - a.rx!.enteredAt.getTime())
      .map(strip),
  };
}

// ---------------------------------------------------------------- read models

export interface RxItemView extends RxItem {
  genericName: string | null;
  strength: string | null;
}

export interface OrderView {
  id: string;
  kind: OrderKind;
  serviceId: string | null;
  code: string | null;
  name: string | null;
  nameHi: string | null;
  priority: string;
  notes: string | null;
  status: OrderStatus;
  /** On a bill line (draft or final). */
  onBill: boolean;
  expectedDate: string | null;
}

export interface SavedRx {
  id: string;
  version: number;
  status: RxStatus;
  needsVerification: boolean;
  enteredAt: Date;
  enteredByName: string;
  verifiedAt: Date | null;
  scanDocumentId: string | null;
  warnings: RxWarning[];
  items: RxItemView[];
}

export interface NoteView {
  complaints: string[];
  complaintsText: string | null;
  diagnosis: string | null;
  advice: string[];
  adviceText: string | null;
  followUpDate: string | null;
}

export interface QuickOrder {
  label: string;
  /** Empty when the label matches no active orderable service (shown disabled). */
  services: { id: string; name: string; kind: OrderKind }[];
}

export interface OrderableService {
  id: string;
  code: string;
  name: string;
  nameHi: string | null;
  kind: OrderKind;
}

export interface RxContext {
  encounter: {
    id: string;
    number: string;
    visitDate: string;
    visitType: string;
    open: boolean;
  };
  token: { id: string; tokenNo: number; queueState: QueueState } | null;
  patient: {
    id: string;
    uhid: string;
    fullName: string;
    nameHi: string | null;
    dob: string;
    sex: string;
    mobileLast4: string | null;
  };
  doctor: { id: string; displayName: string; displayNameHi: string | null };
  /** Today's weight from the vitals desk (paediatric dose checks arrive with OPD-06). */
  weightKg: number | null;
  /** The vitals desk used the pregnant form for this visit. */
  pregnantForm: boolean;
  current: SavedRx | null;
  orders: OrderView[];
  note: NoteView | null;
  draft: { payload: RxDraftPayload; savedAt: Date; savedByName: string } | null;
  scans: { id: string; createdAt: Date }[];
  quickOrders: QuickOrder[];
  chips: { complaints: string[]; advice: string[] };
  settings: { requirePhoto: boolean; hindiPhrases: Record<string, string> };
  hasLastRx: boolean;
}

const num = (v: string | null) => (v === null ? null : Number(v));

async function itemViews(q: Queryable, prescriptionId: string): Promise<RxItemView[]> {
  const rows = await q
    .select({ item: prescriptionItem, genericName: drug.genericName, strength: drug.strength })
    .from(prescriptionItem)
    .leftJoin(drug, eq(drug.id, prescriptionItem.drugId))
    .where(eq(prescriptionItem.prescriptionId, prescriptionId))
    .orderBy(asc(prescriptionItem.seq));
  return rows.map(({ item: i, genericName, strength }) => ({
    drugId: i.drugId,
    drugName: i.drugName,
    form: i.form as DrugForm | null,
    doseText: i.doseText,
    frequencyCode: i.frequencyCode as FrequencyCode | null,
    pattern: i.pattern,
    timing: i.timing as RxTiming | null,
    route: i.route as RxRoute | null,
    durationValue: i.durationValue,
    durationUnit: i.durationUnit as DurationUnit | null,
    quantity: num(i.quantityCalc),
    instructionsEn: i.instructionsEn,
    instructionsHi: i.instructionsHi,
    sourceLine: i.sourceLine,
    genericName,
    strength,
  }));
}

async function currentRx(q: Queryable, encounterId: string): Promise<SavedRx | null> {
  const [row] = await q
    .select({ rx: prescription, enteredByName: appUser.fullName })
    .from(prescription)
    .innerJoin(appUser, eq(appUser.id, prescription.enteredBy))
    .where(
      and(eq(prescription.encounterId, encounterId), inArray(prescription.status, [...CURRENT_RX])),
    );
  if (!row) return null;
  return {
    id: row.rx.id,
    version: row.rx.version,
    status: row.rx.status as RxStatus,
    needsVerification: row.rx.needsVerification,
    enteredAt: row.rx.enteredAt,
    enteredByName: row.enteredByName,
    verifiedAt: row.rx.verifiedAt,
    scanDocumentId: row.rx.paperScanDocumentId,
    warnings: row.rx.warnings,
    items: await itemViews(q, row.rx.id),
  };
}

/** Live (not cancelled) orders of the visit, oldest first. */
export async function ordersOfEncounter(
  q: Queryable,
  facilityId: string,
  encounterId: string,
): Promise<OrderView[]> {
  const rows = await q
    .select({
      id: clinicalOrder.id,
      kind: clinicalOrder.kind,
      serviceId: clinicalOrder.serviceId,
      code: service.code,
      name: service.name,
      nameHi: service.nameHi,
      priority: clinicalOrder.priority,
      notes: clinicalOrder.notes,
      status: clinicalOrder.status,
      billLineId: clinicalOrder.billLineId,
      expectedDate: clinicalOrder.expectedDate,
    })
    .from(clinicalOrder)
    .leftJoin(service, eq(service.id, clinicalOrder.serviceId))
    .where(
      and(
        eq(clinicalOrder.facilityId, facilityId),
        eq(clinicalOrder.encounterId, encounterId),
        ne(clinicalOrder.status, 'cancelled'),
      ),
    )
    .orderBy(asc(clinicalOrder.createdAt), asc(clinicalOrder.id));
  return rows.map(({ billLineId, ...r }) => ({
    ...r,
    kind: r.kind as OrderKind,
    status: r.status as OrderStatus,
    onBill: billLineId !== null,
  }));
}

/** Advice is stored as lines; lines that are chips come back as chips (round trip of the tab). */
function noteView(
  row: typeof clinicalNote.$inferSelect | undefined,
  adviceChips: readonly string[],
): NoteView | null {
  if (!row) return null;
  const lines = (row.advice ?? '').split('\n').filter((l) => l.trim());
  const chipSet = new Set(adviceChips);
  return {
    complaints: row.complaints.map((c) => c.text),
    complaintsText: row.history,
    diagnosis: row.provisionalDiagnosis.map((d) => d.text).join('; ') || null,
    advice: lines.filter((l) => chipSet.has(l)),
    adviceText: lines.filter((l) => !chipSet.has(l)).join('\n') || null,
    followUpDate: row.followUpDate,
  };
}

const ORDERABLE = Object.keys(ORDERABLE_CATEGORIES);

const orderKindOf = (category: string): OrderKind | null =>
  isOrderableCategory(category) ? ORDERABLE_CATEGORIES[category] : null;

/**
 * The doctor's quick-tick list (same list and order as the OPD sheet, docs/11 §2.4) with the
 * services each label orders: `opd.quickOrderServices` by code, else a service whose code, short
 * code or name is the label.
 */
async function quickOrders(
  q: Queryable,
  facilityId: string,
  labels: readonly string[],
  map: Record<string, string[]>,
): Promise<QuickOrder[]> {
  const svcs = await q
    .select({
      id: service.id,
      code: service.code,
      shortCode: service.shortCode,
      name: service.name,
      category: service.category,
    })
    .from(service)
    .where(
      and(
        eq(service.facilityId, facilityId),
        eq(service.status, 'active'),
        eq(service.isActive, true),
        inArray(service.category, ORDERABLE),
      ),
    );
  const byCode = new Map(svcs.map((s) => [s.code.toLowerCase(), s]));
  const lc = (s: string | null) => s?.trim().toLowerCase() ?? '';
  return labels.map((label) => {
    const codes = map[label];
    const found = codes
      ? codes.map((c) => byCode.get(c.toLowerCase())).filter((s) => !!s)
      : svcs.filter(
          (s) =>
            lc(s.code) === lc(label) || lc(s.shortCode) === lc(label) || lc(s.name) === lc(label),
        );
    return {
      label,
      services: found.map((s) => ({ id: s.id, name: s.name, kind: orderKindOf(s.category)! })),
    };
  });
}

async function previousRxId(q: Queryable, e: EncounterRow): Promise<string | null> {
  const [row] = await q
    .select({ id: prescription.id })
    .from(prescription)
    .innerJoin(encounter, eq(encounter.id, prescription.encounterId))
    .where(
      and(
        eq(prescription.patientId, e.patientId),
        eq(prescription.doctorId, e.doctorId),
        ne(prescription.encounterId, e.id),
        inArray(prescription.status, [...CURRENT_RX]),
        eq(encounter.isRestricted, false),
      ),
    )
    .orderBy(desc(prescription.enteredAt))
    .limit(1);
  return row?.id ?? null;
}

/** Everything the transcription screen needs for one visit. */
export async function rxContext(
  tx: Tx,
  facilityId: string,
  encounterId: string,
): Promise<RxContext> {
  const e = await loadEncounter(tx, facilityId, encounterId);
  const [p] = await tx
    .select({
      id: patient.id,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      mobile: patient.mobile,
    })
    .from(patient)
    .where(eq(patient.id, e.patientId));
  const [doc] = await tx
    .select({
      id: doctorProfile.id,
      displayName: doctorProfile.displayName,
      displayNameHi: doctorProfile.displayNameHi,
    })
    .from(doctorProfile)
    .where(eq(doctorProfile.id, e.doctorId));
  const [token] = await tx
    .select({ id: opdToken.id, tokenNo: opdToken.tokenNo, queueState: opdToken.queueState })
    .from(opdToken)
    .where(eq(opdToken.encounterId, e.id));
  const [v] = await tx
    .select({ weightKg: vitals.weightKg, group: vitals.formGroup })
    .from(vitals)
    .where(and(eq(vitals.encounterId, e.id), eq(vitals.status, 'active')));
  const cfg = await readSettings(tx, facilityId, [
    'rx.requirePhoto',
    'rx.hindiPhrases',
    'opd.quickOrders',
    'opd.quickOrderServices',
    'opd.complaintChips',
    'opd.adviceChips',
  ]);
  const [noteRow] = await tx
    .select()
    .from(clinicalNote)
    .where(
      and(
        eq(clinicalNote.encounterId, e.id),
        eq(clinicalNote.kind, 'opd'),
        eq(clinicalNote.status, 'final'),
      ),
    );
  const [draftRow] = await tx
    .select({
      payload: rxDraft.payload,
      savedAt: rxDraft.savedAt,
      savedByName: appUser.fullName,
    })
    .from(rxDraft)
    .innerJoin(appUser, eq(appUser.id, rxDraft.savedBy))
    .where(and(eq(rxDraft.encounterId, e.id), eq(rxDraft.status, 'open')));
  const scans = await tx
    .select({ id: document.id, createdAt: document.createdAt })
    .from(document)
    .where(
      and(
        eq(document.facilityId, facilityId),
        eq(document.kind, 'rx_scan'),
        eq(document.entity, 'encounter'),
        eq(document.entityId, e.id),
        eq(document.status, 'active'),
      ),
    )
    .orderBy(asc(document.createdAt));
  const labels = (cfg['opd.quickOrders'][e.doctorId] ?? DEFAULT_QUICK_ORDERS).slice(
    0,
    MAX_QUICK_ORDERS_ON_SHEET,
  );
  return {
    encounter: {
      id: e.id,
      number: e.number,
      visitDate: e.visitDate,
      visitType: e.visitType,
      open: e.status === 'open',
    },
    token: token ? { ...token, queueState: token.queueState as QueueState } : null,
    patient: {
      id: p!.id,
      uhid: p!.uhid,
      fullName: p!.fullName,
      nameHi: p!.nameHi,
      dob: p!.dob,
      sex: p!.sex,
      mobileLast4: p!.mobile ? p!.mobile.slice(-4) : null,
    },
    doctor: doc!,
    weightKg: v?.weightKg ? Number(v.weightKg) : null,
    pregnantForm: v?.group === 'pregnant',
    current: await currentRx(tx, e.id),
    orders: await ordersOfEncounter(tx, facilityId, e.id),
    note: noteView(noteRow, cfg['opd.adviceChips']),
    draft: draftRow ?? null,
    scans,
    quickOrders: await quickOrders(tx, facilityId, labels, cfg['opd.quickOrderServices']),
    chips: { complaints: cfg['opd.complaintChips'], advice: cfg['opd.adviceChips'] },
    settings: {
      requirePhoto: cfg['rx.requirePhoto'],
      hindiPhrases: cfg['rx.hindiPhrases'],
    },
    hasLastRx: (await previousRxId(tx, e)) !== null,
  };
}

/** Rows of the patient's previous Rx from the same doctor ("Repeat last Rx", docs/11 §2.3). */
export async function lastRxItems(
  tx: Tx,
  facilityId: string,
  encounterId: string,
): Promise<{ enteredAt: Date; items: RxItemView[] } | null> {
  const e = await loadEncounter(tx, facilityId, encounterId);
  const id = await previousRxId(tx, e);
  if (!id) return null;
  const [rx] = await tx
    .select({ enteredAt: prescription.enteredAt })
    .from(prescription)
    .where(eq(prescription.id, id));
  return { enteredAt: rx!.enteredAt, items: await itemViews(tx, id) };
}

// ---------------------------------------------------------------- search

export interface DrugHit {
  id: string;
  brandName: string;
  genericName: string | null;
  strength: string | null;
  form: DrugForm;
  isStocked: boolean;
  defaultDoseText: string | null;
  /** Times this doctor prescribed it (the ranking, docs/11 §2.3). */
  uses: number;
}

/**
 * Drug type-ahead over brand + generic (docs/11 §2.3): ranked by how often the visit's doctor
 * prescribed it, then stocked items, then the typed form, then closeness of the match.
 */
export async function searchDrugs(
  tx: Tx,
  facilityId: string,
  encounterId: string,
  query: { q: string; form?: DrugForm | null },
): Promise<DrugHit[]> {
  const e = await loadEncounter(tx, facilityId, encounterId);
  const term = searchQueryText(query.q);
  if (!term) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const uses = tx
    .select({ drugId: prescriptionItem.drugId, n: sql<number>`count(*)::int`.as('n') })
    .from(prescriptionItem)
    .innerJoin(prescription, eq(prescription.id, prescriptionItem.prescriptionId))
    .where(
      and(eq(prescription.doctorId, e.doctorId), inArray(prescription.status, [...CURRENT_RX])),
    )
    .groupBy(prescriptionItem.drugId)
    .as('uses');
  await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.4', true)`);
  const rows = await tx
    .select({
      id: drug.id,
      brandName: drug.brandName,
      genericName: drug.genericName,
      strength: drug.strength,
      form: drug.form,
      isStocked: drug.isStocked,
      defaultDoseText: drug.defaultDoseText,
      uses: sql<number>`coalesce(${uses.n}, 0)`,
    })
    .from(drug)
    .leftJoin(uses, eq(uses.drugId, drug.id))
    .where(
      and(
        eq(drug.facilityId, facilityId),
        eq(drug.status, 'active'),
        eq(drug.isActive, true),
        or(sql`${drug.searchText} like ${like}`, sql`${term} <% ${drug.searchText}`),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${uses.n}, 0)`),
      desc(drug.isStocked),
      desc(sql`${drug.form} = ${query.form ?? ''}`),
      desc(sql`${drug.searchText} like ${`${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`),
      desc(sql`word_similarity(${term}, ${drug.searchText})`),
      asc(drug.brandName),
      asc(drug.strength),
    )
    .limit(12);
  return rows.map((r) => ({ ...r, form: r.form as DrugForm, uses: Number(r.uses) }));
}

/** Orderable services (lab, USG, procedure, cardiology) for the Orders tab search. */
export async function searchOrderables(
  q: Queryable,
  facilityId: string,
  text: string,
): Promise<OrderableService[]> {
  const term = searchQueryText(text);
  if (!term) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await q
    .select({
      id: service.id,
      code: service.code,
      name: service.name,
      nameHi: service.nameHi,
      category: service.category,
    })
    .from(service)
    .where(
      and(
        eq(service.facilityId, facilityId),
        eq(service.status, 'active'),
        eq(service.isActive, true),
        inArray(service.category, ORDERABLE),
        or(sql`${service.searchText} like ${like}`, sql`${term} <% ${service.searchText}`),
      ),
    )
    .orderBy(asc(service.name))
    .limit(20);
  return rows.map(({ category, ...r }) => ({ ...r, kind: orderKindOf(category)! }));
}

// ---------------------------------------------------------------- draft

/** Autosave (docs/01 §3): one row per visit, overwritten; `open` again after a discard. */
export async function saveRxDraft(
  tx: Tx,
  actor: RxActor,
  input: { encounterId: string; payload: RxDraftPayload },
  now: Date,
): Promise<{ savedAt: Date }> {
  await loadEncounter(tx, actor.facilityId, input.encounterId);
  await tx
    .insert(rxDraft)
    .values({
      id: uuidv7(),
      facilityId: actor.facilityId,
      encounterId: input.encounterId,
      payload: input.payload,
      savedAt: now,
      savedBy: actor.userId,
      status: 'open',
    })
    .onConflictDoUpdate({
      target: rxDraft.encounterId,
      set: { payload: input.payload, savedAt: now, savedBy: actor.userId, status: 'open' },
    });
  return { savedAt: now };
}

/** "Start over": the server draft is kept but no longer offered for restore. */
export async function discardRxDraft(tx: Tx, actor: RxActor, encounterId: string): Promise<void> {
  await loadEncounter(tx, actor.facilityId, encounterId);
  await tx
    .update(rxDraft)
    .set({ status: 'discarded' })
    .where(and(eq(rxDraft.encounterId, encounterId), eq(rxDraft.status, 'open')));
}

// ---------------------------------------------------------------- paper photo

export interface RxScanFile {
  relPath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Registers a stored photo of the paper Rx (`document.kind = rx_scan`, entity = the encounter;
 * docs/11 §2.2). The file is written by the caller before this transaction (docs/01 §2), and
 * removed by it again when this throws. A replaced photo is cancelled, never deleted.
 */
export async function attachRxScan(
  tx: Tx,
  actor: RxActor,
  input: { encounterId: string; replacesDocumentId: string | null; file: RxScanFile },
  now: Date,
): Promise<{ documentId: string }> {
  const e = await loadEncounter(tx, actor.facilityId, input.encounterId, true);
  requireOpen(e);
  if (input.replacesDocumentId) {
    const done = await tx
      .update(document)
      .set({
        status: 'cancelled',
        cancelReason: 'Replaced by a new photo',
        cancelledBy: actor.userId,
        cancelledAt: now,
      })
      .where(
        and(
          eq(document.id, input.replacesDocumentId),
          eq(document.facilityId, actor.facilityId),
          eq(document.kind, 'rx_scan'),
          eq(document.entityId, e.id),
          eq(document.status, 'active'),
        ),
      )
      .returning({ id: document.id });
    if (done.length === 0) throw new RxInputError('rx.scanNotFound');
  }
  const id = uuidv7();
  await tx.insert(document).values({
    id,
    facilityId: actor.facilityId,
    kind: 'rx_scan',
    entity: 'encounter',
    entityId: e.id,
    filePath: input.file.relPath,
    mime: 'image/jpeg',
    sizeBytes: input.file.sizeBytes,
    sha256: input.file.sha256,
    pages: 1,
  });
  return { documentId: id };
}

/** A stored Rx photo for display (any status: an old version still shows its own photo). */
export async function readRxScan(
  q: Queryable,
  facilityId: string,
  documentId: string,
): Promise<{ filePath: string; mime: string } | null> {
  const [row] = await q
    .select({ filePath: document.filePath, mime: document.mime, entityId: document.entityId })
    .from(document)
    .innerJoin(encounter, eq(encounter.id, document.entityId))
    .where(
      and(
        eq(document.id, documentId),
        eq(document.facilityId, facilityId),
        eq(document.kind, 'rx_scan'),
        eq(document.entity, 'encounter'),
        eq(encounter.isRestricted, false),
      ),
    );
  return row ? { filePath: row.filePath, mime: row.mime } : null;
}

// ---------------------------------------------------------------- save

export interface SaveRxResult {
  prescriptionId: string;
  version: number;
  needsVerification: boolean;
  warnings: RxWarning[];
  ordersAdded: number;
  ordersCancelled: number;
  tokenNo: number | null;
  queueState: QueueState | null;
}

const toNumeric = (n: number | null) => (n === null ? null : String(n));

/**
 * Saves the transcription (docs/11 §2.7): `prescription.status = final`, `source =
 * transcribed_from_paper`, its rows, the orders (each a `clinical_order` in `ordered` that billing
 * sees at once), the admission advice, the visit note with the follow-up date, and the token
 * moves to `rx_entered`. Re-saving a visit that already has an Rx is a correction (next version).
 * `random` decides the verification sample (Q15); crypto-backed by default.
 */
export async function saveRx(
  tx: Tx,
  actor: RxActor,
  raw: SaveRxInput,
  now: Date,
  random: () => number = () => randomInt(0, 1_000_000) / 1_000_000,
): Promise<SaveRxResult> {
  const { idempotencyKey, ...input } = saveRxSchema.parse(raw);
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'rx.save',
      key: idempotencyKey,
      payload: input,
    },
    async () => {
      const e = await loadEncounter(tx, actor.facilityId, input.encounterId, true);
      requireOpen(e);
      const cfg = await readSettings(tx, actor.facilityId, [
        'rx.requirePhoto',
        'rx.verifyMode',
        'rx.verifySamplePercent',
        'rx.hindiPhrases',
        'opd.adviceChips',
      ]);

      // ---- paper photo
      if (input.scanDocumentId) {
        const [scan] = await tx
          .select({ id: document.id })
          .from(document)
          .where(
            and(
              eq(document.id, input.scanDocumentId),
              eq(document.facilityId, actor.facilityId),
              eq(document.kind, 'rx_scan'),
              eq(document.entityId, e.id),
              eq(document.status, 'active'),
            ),
          );
        if (!scan) throw new RxInputError('rx.scanNotFound');
      } else if (cfg['rx.requirePhoto']) {
        throw new RxInputError('rx.photoRequired');
      }

      const hasNote =
        input.note.complaints.length > 0 ||
        !!input.note.complaintsText ||
        !!input.note.diagnosis ||
        input.note.advice.length > 0 ||
        !!input.note.adviceText;
      if (
        input.items.length === 0 &&
        input.orders.length === 0 &&
        !input.admission.advised &&
        !input.followUpDate &&
        !hasNote
      ) {
        throw new RxInputError('rx.empty');
      }
      if (input.followUpDate && !isValidFollowUpDate(input.followUpDate, now)) {
        throw new RxInputError('rx.followUpInvalid');
      }
      if (input.admission.expectedDate && input.admission.expectedDate < istDateString(now)) {
        throw new RxInputError('rx.admissionDateInvalid');
      }

      // ---- drugs from the master (form and generic come from it)
      const drugIds = [...new Set(input.items.flatMap((i) => (i.drugId ? [i.drugId] : [])))];
      const drugs = drugIds.length
        ? await tx
            .select({ id: drug.id, form: drug.form, genericName: drug.genericName })
            .from(drug)
            .where(
              and(
                inArray(drug.id, drugIds),
                eq(drug.facilityId, actor.facilityId),
                eq(drug.status, 'active'),
              ),
            )
        : [];
      if (drugs.length !== drugIds.length) throw new RxInputError('rx.drugNotFound');
      const drugById = new Map(drugs.map((d) => [d.id, d]));
      const phrases = cfg['rx.hindiPhrases'];
      const items = input.items.map((i) => {
        const d = i.drugId ? drugById.get(i.drugId) : undefined;
        const form = (d?.form as DrugForm | undefined) ?? i.form;
        const quantity =
          i.quantity ??
          rxQuantity({
            form,
            pattern: i.pattern,
            frequencyCode: i.frequencyCode,
            durationValue: i.durationValue,
            durationUnit: i.durationUnit,
          });
        return {
          ...i,
          form,
          quantity,
          genericName: d?.genericName ?? null,
          instructionsHi: i.instructionsHi ?? (buildInstruction(i, 'hi', phrases) || null),
          instructionsEn: i.instructionsEn ?? (buildInstruction(i, 'en') || null),
        };
      });
      const warnings = rxWarnings(items);

      // ---- orderable services
      const serviceIds = input.orders.map((o) => o.serviceId);
      const svcs = serviceIds.length
        ? await tx
            .select({
              id: service.id,
              category: service.category,
              labTestId: service.linkedLabTestId,
              usgProcedureId: service.linkedUsgProcedureId,
            })
            .from(service)
            .where(
              and(
                inArray(service.id, serviceIds),
                eq(service.facilityId, actor.facilityId),
                eq(service.status, 'active'),
                eq(service.isActive, true),
              ),
            )
        : [];
      if (svcs.length !== serviceIds.length || svcs.some((s) => !isOrderableCategory(s.category))) {
        throw new RxInputError('rx.orderNotOrderable');
      }
      const svcById = new Map(svcs.map((s) => [s.id, s]));

      // ---- prescription (next version on a correction)
      const [prev] = await tx
        .select({ id: prescription.id, version: prescription.version })
        .from(prescription)
        .where(
          and(eq(prescription.encounterId, e.id), inArray(prescription.status, [...CURRENT_RX])),
        )
        .for('update');
      if (prev) {
        await tx
          .update(prescription)
          .set({ status: 'superseded', supersededAt: now })
          .where(eq(prescription.id, prev.id));
      }
      const verify = needsVerification(
        cfg['rx.verifyMode'],
        cfg['rx.verifySamplePercent'],
        warnings.length > 0,
        random(),
      );
      const rxId = uuidv7();
      const version = (prev?.version ?? 0) + 1;
      await tx.insert(prescription).values({
        id: rxId,
        facilityId: actor.facilityId,
        encounterId: e.id,
        patientId: e.patientId,
        doctorId: e.doctorId,
        source: 'transcribed_from_paper',
        status: 'final',
        version,
        supersedesId: prev?.id ?? null,
        enteredBy: actor.userId,
        enteredAt: now,
        needsVerification: verify,
        warnings,
        paperScanDocumentId: input.scanDocumentId,
      });
      if (items.length > 0) {
        await tx.insert(prescriptionItem).values(
          items.map((i, n) => ({
            id: uuidv7(),
            facilityId: actor.facilityId,
            prescriptionId: rxId,
            seq: n + 1,
            drugId: i.drugId,
            freeTextDrug: i.drugId ? null : i.drugName,
            drugName: i.drugName,
            form: i.form,
            doseText: i.doseText,
            frequencyCode: i.frequencyCode,
            pattern: i.pattern,
            timing: i.timing,
            route: i.route,
            durationValue: i.durationValue,
            durationUnit: i.durationUnit,
            quantityCalc: toNumeric(i.quantity),
            instructionsEn: i.instructionsEn,
            instructionsHi: i.instructionsHi,
            sourceLine: i.sourceLine,
          })),
        );
      }

      // ---- orders: keep, add, cancel
      const live = await tx
        .select()
        .from(clinicalOrder)
        .where(and(eq(clinicalOrder.encounterId, e.id), ne(clinicalOrder.status, 'cancelled')))
        .for('update');
      const cancelOrder = (id: string, reason: string) =>
        tx
          .update(clinicalOrder)
          .set({
            status: 'cancelled',
            cancelReason: reason,
            cancelledBy: actor.userId,
            cancelledAt: now,
          })
          .where(eq(clinicalOrder.id, id));
      const wanted = new Map(input.orders.map((o) => [o.serviceId, o]));
      let ordersAdded = 0;
      let ordersCancelled = 0;
      for (const o of live.filter((x) => x.kind !== 'admission')) {
        const want = o.serviceId ? wanted.get(o.serviceId) : undefined;
        if (want) {
          wanted.delete(o.serviceId!);
          if (o.status === 'ordered' && (o.priority !== want.priority || o.notes !== want.notes)) {
            await tx
              .update(clinicalOrder)
              .set({ priority: want.priority, notes: want.notes })
              .where(eq(clinicalOrder.id, o.id));
          }
          continue;
        }
        if (o.status !== 'ordered' || o.billLineId) throw new RxInputError('rx.orderBilled');
        await cancelOrder(o.id, 'Removed in Rx correction');
        ordersCancelled++;
      }
      for (const o of wanted.values()) {
        const s = svcById.get(o.serviceId)!;
        await tx.insert(clinicalOrder).values({
          id: uuidv7(),
          facilityId: actor.facilityId,
          encounterId: e.id,
          patientId: e.patientId,
          prescriptionId: rxId,
          kind: orderKindOf(s.category)!,
          serviceId: s.id,
          labTestId: s.labTestId,
          usgProcedureId: s.usgProcedureId,
          priority: o.priority,
          notes: o.notes,
          orderedBy: e.doctorId,
          enteredBy: actor.userId,
        });
        ordersAdded++;
      }
      const admission = live.find((x) => x.kind === 'admission');
      if (input.admission.advised) {
        if (admission) {
          await tx
            .update(clinicalOrder)
            .set({ expectedDate: input.admission.expectedDate, notes: input.admission.note })
            .where(eq(clinicalOrder.id, admission.id));
        } else {
          await tx.insert(clinicalOrder).values({
            id: uuidv7(),
            facilityId: actor.facilityId,
            encounterId: e.id,
            patientId: e.patientId,
            prescriptionId: rxId,
            kind: 'admission',
            serviceId: null,
            expectedDate: input.admission.expectedDate,
            notes: input.admission.note,
            orderedBy: e.doctorId,
            enteredBy: actor.userId,
          });
          ordersAdded++;
        }
      } else if (admission) {
        if (admission.status !== 'ordered') throw new RxInputError('rx.orderBilled');
        await cancelOrder(admission.id, 'Removed in Rx correction');
        ordersCancelled++;
      }

      // ---- note and follow-up (the previous note is superseded, never edited)
      await tx
        .update(clinicalNote)
        .set({ status: 'superseded', supersededAt: now })
        .where(
          and(
            eq(clinicalNote.encounterId, e.id),
            eq(clinicalNote.kind, 'opd'),
            eq(clinicalNote.status, 'final'),
          ),
        );
      if (hasNote || input.followUpDate) {
        const advice = [
          ...input.note.advice,
          ...(input.note.adviceText ? [input.note.adviceText] : []),
        ];
        await tx.insert(clinicalNote).values({
          id: uuidv7(),
          facilityId: actor.facilityId,
          encounterId: e.id,
          patientId: e.patientId,
          prescriptionId: rxId,
          kind: 'opd',
          complaints: input.note.complaints.map((text) => ({ text })),
          history: input.note.complaintsText,
          provisionalDiagnosis: input.note.diagnosis ? [{ text: input.note.diagnosis }] : [],
          advice: advice.length ? advice.join('\n') : null,
          followUpDate: input.followUpDate,
          status: 'final',
          enteredBy: actor.userId,
        });
      }

      // ---- draft used, token on
      await tx
        .update(rxDraft)
        .set({ status: 'used' })
        .where(and(eq(rxDraft.encounterId, e.id), eq(rxDraft.status, 'open')));
      const [token] = await tx
        .select({ id: opdToken.id, tokenNo: opdToken.tokenNo, queueState: opdToken.queueState })
        .from(opdToken)
        .where(eq(opdToken.encounterId, e.id));
      let queueState = (token?.queueState as QueueState | undefined) ?? null;
      if (token && canTransition(token.queueState as QueueState, 'rx_entered')) {
        const moved = await advanceToken(tx, actor, token.id, 'rx_entered', now, 'rx');
        queueState = moved.queueState as QueueState;
      }
      return {
        prescriptionId: rxId,
        version,
        needsVerification: verify,
        warnings,
        ordersAdded,
        ordersCancelled,
        tokenNo: token?.tokenNo ?? null,
        queueState,
      };
    },
  );
}

// ---------------------------------------------------------------- doctor verification (Q15)

export interface VerificationItem {
  prescriptionId: string;
  encounterId: string;
  version: number;
  enteredAt: Date;
  enteredByName: string;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  dob: string;
  sex: string;
  scanDocumentId: string | null;
  warnings: RxWarning[];
  items: RxItemView[];
}

/** Doctor profiles linked to this user (a doctor verifies only their own prescriptions). */
async function doctorIdsOfUser(q: Queryable, facilityId: string, userId: string) {
  const rows = await q
    .select({ id: doctorProfile.id })
    .from(doctorProfile)
    .where(and(eq(doctorProfile.facilityId, facilityId), eq(doctorProfile.userId, userId)));
  return rows.map((r) => r.id);
}

/** The doctor's verification queue (docs/11 §2.7): oldest first, with the rows and photo. */
export async function rxVerificationQueue(
  tx: Tx,
  facilityId: string,
  userId: string,
): Promise<VerificationItem[]> {
  const doctors = await doctorIdsOfUser(tx, facilityId, userId);
  if (doctors.length === 0) return [];
  const rows = await tx
    .select({
      prescriptionId: prescription.id,
      encounterId: prescription.encounterId,
      version: prescription.version,
      enteredAt: prescription.enteredAt,
      enteredByName: appUser.fullName,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      scanDocumentId: prescription.paperScanDocumentId,
      warnings: prescription.warnings,
    })
    .from(prescription)
    .innerJoin(patient, eq(patient.id, prescription.patientId))
    .innerJoin(appUser, eq(appUser.id, prescription.enteredBy))
    .innerJoin(encounter, eq(encounter.id, prescription.encounterId))
    .where(
      and(
        eq(prescription.facilityId, facilityId),
        eq(prescription.status, 'final'),
        eq(prescription.needsVerification, true),
        inArray(prescription.doctorId, doctors),
        eq(encounter.isRestricted, false),
      ),
    )
    .orderBy(asc(prescription.enteredAt))
    .limit(50);
  const out: VerificationItem[] = [];
  for (const r of rows) out.push({ ...r, items: await itemViews(tx, r.prescriptionId) });
  return out;
}

/** The doctor confirms a transcription matches the paper ("Verify", docs/11 §2.7). */
export async function verifyRx(
  tx: Tx,
  actor: RxActor,
  prescriptionId: string,
  now: Date,
): Promise<{ prescriptionId: string; status: RxStatus }> {
  const [rx] = await tx
    .select()
    .from(prescription)
    .where(and(eq(prescription.id, prescriptionId), eq(prescription.facilityId, actor.facilityId)))
    .for('update');
  if (!rx) throw new RxInputError('rx.notFound');
  const doctors = await doctorIdsOfUser(tx, actor.facilityId, actor.userId);
  if (!doctors.includes(rx.doctorId)) throw new RxInputError('rx.notYourPatient');
  if (rx.status !== 'final' || !rx.needsVerification) {
    throw new RxInputError('rx.notPendingVerification');
  }
  await tx
    .update(prescription)
    .set({ status: 'verified', verifiedBy: actor.userId, verifiedAt: now })
    .where(eq(prescription.id, rx.id));
  return { prescriptionId: rx.id, status: 'verified' };
}
