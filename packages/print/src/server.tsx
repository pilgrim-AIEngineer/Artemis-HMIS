/**
 * Server side of printing (web print route and worker `pdf.render`): loads the facility header
 * and the template's data from the database and assembles a `PrintDocument`. Import from
 * `@hmis/print/server`; the client-safe pieces are in `@hmis/print`.
 */
import {
  activeVitals,
  ancSummary,
  getGrowthOverview,
  getImmunisationCard,
  getPregnancyView,
  facilityCloseView,
  loadDayClose,
  loadReceipt,
  readSettings,
  type Db,
  type Tx,
} from '@hmis/db';
import {
  doctorProfile,
  encounter,
  facility,
  locality,
  opdToken,
  patient,
  payer,
} from '@hmis/db/schema';
import {
  DEFAULT_QUICK_ORDERS,
  formatDate,
  formatGa as formatGaDays,
  addDays,
  istDateString,
  outstandingDoses,
  parseIsoDate,
  toIsoDate,
  visitQrPayload,
} from '@hmis/shared';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import type { ReactNode } from 'react';
import { L } from './labels';
import { initials, qrSvg } from './doc-utils';
import { SampleDocument } from './templates/sample';
import { ageSex, mobileLast4, sheetVitals } from './templates/format';
import { AncCard, type AncCardData } from './templates/anc-card';
import { GrowthChartSheet, type GrowthChartData } from './templates/growth-chart';
import {
  VaccinationCard,
  VaccinationCertificate,
  type VaccinationData,
} from './templates/vaccination';
import { OpdSheet, type OpdSheetData } from './templates/opd-sheet';
import { PatientSticker, UhidCard, type PatientLabelData } from './templates/patient-labels';
import {
  DayCloseSlip,
  FacilityCloseSummary,
  type DayCloseSlipData,
  type FacilityCloseSummaryData,
} from './templates/day-close';
import { Receipt, ReceiptA5, receiptStamp, type ReceiptPrintData } from './templates/receipt';
import {
  ANC_CARD_TEMPLATE,
  DAY_CLOSE_TEMPLATE,
  GROWTH_CHART_TEMPLATE,
  VACCINATION_CARD_TEMPLATE,
  VACCINATION_CERTIFICATE_TEMPLATE,
  FACILITY_CLOSE_TEMPLATE,
  findTemplateMeta,
  OPD_SHEET_TEMPLATE,
  PATIENT_STICKER_TEMPLATE,
  PRINT_TEMPLATE_METAS,
  RECEIPT_A5_TEMPLATE,
  RECEIPT_TEMPLATE,
  UHID_CARD_TEMPLATE,
} from './templates/meta';
import type {
  Bilingual,
  PrintDocument,
  PrintHeaderData,
  PrintMeta,
  PrintTemplateMeta,
} from './types';

type Queryable = Db | Tx;

export interface LoadContext {
  db: Queryable;
  facilityId: string;
  entityId: string;
}

/** Server-side half of a template: loads its data (null = entity not found) and draws the body. */
interface TemplateImpl<D> {
  meta: PrintTemplateMeta;
  load(ctx: LoadContext): Promise<D | null>;
  body(data: D, meta: PrintMeta, header: PrintHeaderData): ReactNode;
  /** What the QR encodes; defaults to the entity id. Never patient data beyond an identifier. */
  qr?(data: D, entityId: string): string;
  /** A status mark across the page (e.g. a cancelled receipt); null/undefined = none. */
  stamp?(data: D): Bilingual | null;
}

const impl = <D,>(t: TemplateImpl<D>) => t as unknown as TemplateImpl<unknown>;

/** The sample's entity is the facility itself (`/print/sample-a4/<facility id>`). */
const sampleTemplates = PRINT_TEMPLATE_METAS.filter((t) => t.key.startsWith('sample-')).map(
  (meta) =>
    impl({
      meta,
      load: ({ facilityId, entityId }) =>
        Promise.resolve(entityId === facilityId ? { ref: entityId.slice(-8).toUpperCase() } : null),
      body: (data: { ref: string }, pm: PrintMeta) => (
        <SampleDocument paper={meta.paper} data={data} meta={pm} />
      ),
    }),
);

const metaOf = (key: string): PrintTemplateMeta => {
  const m = findTemplateMeta(key);
  if (!m) throw new Error(`template ${key} is not registered`);
  return m;
};

/** `/print/opd-sheet/<encounter id>`: pre-filled A5 sheet; the QR is `E:<encounter id>` (REG-06). */
const opdSheet = impl<OpdSheetData>({
  meta: metaOf(OPD_SHEET_TEMPLATE),
  async load({ db, facilityId, entityId }) {
    const [row] = await db
      .select({
        patientId: patient.id,
        patientName: patient.fullName,
        nameHi: patient.nameHi,
        dob: patient.dob,
        sex: patient.sex,
        uhid: patient.uhid,
        mobile: patient.mobile,
        guardian: patient.guardianName,
        locality: locality.name,
        number: encounter.number,
        startedAt: encounter.startedAt,
        doctorId: doctorProfile.id,
        doctorName: doctorProfile.displayName,
        doctorNameHi: doctorProfile.displayNameHi,
        qualifications: doctorProfile.qualifications,
        registrationNo: doctorProfile.registrationNo,
        payer: payer.name,
      })
      .from(encounter)
      .innerJoin(patient, eq(patient.id, encounter.patientId))
      .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
      .innerJoin(payer, eq(payer.id, encounter.payerId))
      .leftJoin(locality, eq(locality.id, patient.localityId))
      .where(
        and(
          eq(encounter.id, entityId),
          eq(encounter.facilityId, facilityId),
          eq(encounter.type, 'opd'),
          ne(encounter.status, 'cancelled'),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [token] = await db
      .select({ tokenNo: opdToken.tokenNo })
      .from(opdToken)
      .where(eq(opdToken.encounterId, entityId))
      .limit(1);
    const [last] = await db
      .select({ visitDate: encounter.visitDate, doctor: doctorProfile.displayName })
      .from(encounter)
      .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
      .where(
        and(
          eq(encounter.facilityId, facilityId),
          eq(encounter.patientId, row.patientId),
          ne(encounter.status, 'cancelled'),
          lt(encounter.startedAt, row.startedAt),
        ),
      )
      .orderBy(desc(encounter.startedAt))
      .limit(1);
    const reading = await activeVitals(db, facilityId, entityId);
    const anc = await ancSummary(
      db,
      { facilityId, userId: '', mtp: { view: false, edit: false } },
      row.patientId,
      row.startedAt,
    );
    const s = await readSettings(db, facilityId, ['opd.quickOrders']);
    const configured = s['opd.quickOrders'][row.doctorId];
    return {
      doctor: {
        name: row.doctorName,
        nameHi: row.doctorNameHi,
        qualifications: row.qualifications,
        registration: row.registrationNo,
      },
      patient: {
        name: row.patientName,
        nameHi: row.nameHi,
        ageSex: ageSex(row.dob, row.sex, row.startedAt),
        uhid: row.uhid,
        guardian: row.guardian,
        locality: row.locality,
        mobileLast4: mobileLast4(row.mobile),
      },
      visit: {
        number: row.number,
        tokenNo: token?.tokenNo ?? null,
        startedAt: row.startedAt,
        payer: row.payer,
      },
      // Blank boxes until the vitals desk has saved a reading (OPD-01).
      ...(reading ? sheetVitals(reading) : { vitals: null }),
      ...(anc
        ? {
            pregnancy: {
              gaLabel: anc.gaLabel,
              edd: formatDate(anc.eddFinal),
              gpal: anc.gpalText,
              risks: anc.risks.map((r) => r.code),
              lastVisits: anc.lastVisits.map((v) => ({ ...v, date: formatDate(v.date) })),
              testsDue: anc.testsDue.map((t) => ({ hi: t.labelHi, en: t.label })),
              testsOverdue: anc.testsOverdue.map((t) => ({ hi: t.labelHi, en: t.label })),
              td: anc.td,
            },
          }
        : {}),
      lastVisit: last ? { date: formatDate(last.visitDate), doctor: last.doctor } : null,
      quickOrders: configured && configured.length > 0 ? configured : [...DEFAULT_QUICK_ORDERS],
    };
  },
  body: (data, pm) => <OpdSheet data={data} meta={pm} />,
  qr: (_data, entityId) => visitQrPayload(entityId),
});

async function loadPatientLabel({
  db,
  facilityId,
  entityId,
}: LoadContext): Promise<PatientLabelData | null> {
  const [p] = await db
    .select({
      uhid: patient.uhid,
      name: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      mobile: patient.mobile,
    })
    .from(patient)
    .where(
      and(
        eq(patient.id, entityId),
        eq(patient.facilityId, facilityId),
        ne(patient.status, 'cancelled'),
      ),
    )
    .limit(1);
  if (!p) return null;
  return {
    uhid: p.uhid,
    name: p.name,
    nameHi: p.nameHi,
    ageSex: ageSex(p.dob, p.sex, new Date()),
    mobileLast4: mobileLast4(p.mobile),
  };
}

/** `/print/patient-sticker/<patient id>`: 50 × 25 mm label, QR = UHID (REG-07). */
const patientSticker = impl<PatientLabelData>({
  meta: metaOf(PATIENT_STICKER_TEMPLATE),
  load: loadPatientLabel,
  body: (data, pm) => <PatientSticker data={data} meta={pm} />,
  qr: (data) => data.uhid,
});

/** `/print/uhid-card/<patient id>`: front and back of the card, QR = UHID (REG-07). */
const uhidCard = impl<PatientLabelData>({
  meta: metaOf(UHID_CARD_TEMPLATE),
  load: loadPatientLabel,
  body: (data, pm, header) => <UhidCard data={data} header={header} meta={pm} />,
  qr: (data) => data.uhid,
});

async function loadReceiptData({
  db,
  facilityId,
  entityId,
}: LoadContext): Promise<ReceiptPrintData | null> {
  const r = await loadReceipt(db, facilityId, entityId);
  if (!r) return null;
  return {
    number: r.number,
    kind: r.kind,
    receivedAt: r.receivedAt,
    receivedBy: r.receivedByName,
    status: r.status,
    totalPaise: r.totalPaise,
    tenders: r.tenders,
    patient: {
      name: r.patient.fullName,
      nameHi: r.patient.nameHi,
      ageSex: ageSex(r.patient.dob, r.patient.sex, r.receivedAt),
      uhid: r.patient.uhid,
    },
    encounterNumber: r.encounterNumber,
    doctorName: r.doctorName,
    bill: r.bill,
  };
}

/** `/print/receipt/<collection id>`: the receipt of one payment (all modes of a split), 80 mm. */
const receipt = impl<ReceiptPrintData>({
  meta: metaOf(RECEIPT_TEMPLATE),
  load: loadReceiptData,
  body: (data) => <Receipt data={data} />,
  stamp: receiptStamp,
});

/** `/print/receipt-a5/<collection id>`: the same receipt, itemised on A5 (BIL-05). */
const receiptA5 = impl<ReceiptPrintData>({
  meta: metaOf(RECEIPT_A5_TEMPLATE),
  load: loadReceiptData,
  body: (data) => <ReceiptA5 data={data} />,
  stamp: receiptStamp,
});

/** `/print/day-close/<user close id>`: a cashier's close slip on the roll (BIL-06). */
const dayCloseSlip = impl<DayCloseSlipData>({
  meta: metaOf(DAY_CLOSE_TEMPLATE),
  async load({ db, facilityId, entityId }) {
    const c = await loadDayClose(db, facilityId, entityId);
    if (!c || c.kind !== 'user') return null;
    return {
      closeDate: c.closeDate,
      closedAt: c.closedAt,
      userName: c.userName,
      totals: c.totals,
      cashCountedPaise: c.cashCountedPaise,
      differencePaise: c.differencePaise,
      differenceReason: c.differenceReason,
      paymentCount: c.paymentCount,
      denominations: c.denominations,
    };
  },
  body: (data) => <DayCloseSlip data={data} />,
});

/** `/print/facility-close/<facility close id>`: the owner's A4 summary of a closed day (BIL-06). */
const facilityClose = impl<FacilityCloseSummaryData>({
  meta: metaOf(FACILITY_CLOSE_TEMPLATE),
  async load({ db, facilityId, entityId }) {
    const c = await loadDayClose(db, facilityId, entityId);
    if (!c || c.kind !== 'facility') return null;
    const v = await facilityCloseView(db, facilityId, c.closeDate);
    if (!v.close) return null;
    return {
      closeDate: c.closeDate,
      closedAt: c.closedAt,
      closedByName: v.close.closedByName,
      totals: v.close.totals,
      cashCountedPaise: v.close.cashCountedPaise,
      differencePaise: v.close.differencePaise,
      paymentCount: v.close.paymentCount,
      pendingAcknowledged: v.close.pendingAcknowledged,
      note: v.close.note,
      userCloses: v.userCloses.map((u) => ({
        userName: u.userName,
        closedAt: u.closedAt,
        cashExpectedPaise: u.totals.cashPaise,
        cashCountedPaise: u.cashCountedPaise,
        differencePaise: u.differencePaise,
        differenceReason: u.differenceReason,
      })),
      byDoctor: v.byDoctor,
      byDepartment: v.byDepartment,
      upiStatus: v.upiStatus,
      upiDifferencePaise: v.upiDifferencePaise,
    };
  },
  body: (data) => <FacilityCloseSummary data={data} />,
});

/**
 * `/print/anc-card/<pregnancy id>`: the antenatal card (OPD-05). Read with no MTP rights, so a
 * pregnancy closed as MTP is "not found" here and never printed (docs/11 §3.1).
 */
const ancCard = impl<AncCardData>({
  meta: metaOf(ANC_CARD_TEMPLATE),
  async load({ db, facilityId, entityId }) {
    const none = { view: false, edit: false };
    let v;
    try {
      v = await getPregnancyView(db, { facilityId, userId: '', mtp: none }, entityId, new Date());
    } catch {
      return null;
    }
    if (v.status === 'closed') return null;
    const [pt] = await db
      .select({ guardian: patient.guardianName })
      .from(patient)
      .where(eq(patient.id, v.patient.id));
    const states = new Set(['done', 'due', 'overdue', 'upcoming', 'skipped']);
    return {
      patient: {
        name: v.patient.fullName,
        nameHi: v.patient.nameHi,
        ageYears: v.patient.ageYears,
        uhid: v.patient.uhid,
        guardian: pt?.guardian ?? null,
        mobileLast4: v.patient.mobileLast4,
      },
      bookingDate: v.bookingDate,
      lmp: v.dating.lmp,
      edd: v.dating.eddFinal,
      datedBy: v.dating.basis,
      gaLabel: v.ga?.label ?? null,
      gpal: v.gpal.text,
      bloodGroup: v.bloodGroupRh,
      plurality: v.plurality,
      risks: v.risks.map((r) => ({
        code: r.code,
        level: r.level,
        text: r.text ?? null,
        value: r.value ?? null,
      })),
      visits: v.visits.map((x) => ({
        date: x.visitDate,
        gaLabel: x.gaLabel,
        weightKg: x.weightKg,
        bp: x.bpSys === null ? null : `${x.bpSys}/${x.bpDia}`,
        fundalHeightCm: x.fundalHeightCm,
        fhr: x.fhr,
        presentation: x.presentation,
        oedema: x.oedema,
        urineProtein: x.urineProtein,
        urineSugar: x.urineSugar,
        hb: x.hb,
        remarks: x.remarks,
      })),
      schedule: v.schedule
        .filter((s) => states.has(s.state))
        .map((s) => ({
          label: { hi: s.labelHi, en: s.label },
          state: s.state as AncCardData['schedule'][number]['state'],
          date: s.doneDate,
          windowFrom: s.windowFrom,
        })),
      nextVisit: v.nextVisit
        ? { date: v.nextVisit.date, gaLabel: formatGaDays(v.nextVisit.gaAtDate) }
        : null,
    };
  },
  body: (data, pm) => <AncCard data={data} meta={pm} />,
});

/** The vaccines given and still to give, as the card and the certificate print them (OPD-06). */
async function vaccinationData(
  db: Parameters<typeof getImmunisationCard>[0],
  facilityId: string,
  patientId: string,
): Promise<VaccinationData | null> {
  const now = new Date();
  let card;
  try {
    card = await getImmunisationCard(db, { facilityId, userId: '' }, patientId, now);
  } catch {
    return null;
  }
  const [pt] = await db
    .select({ guardian: patient.guardianName })
    .from(patient)
    .where(eq(patient.id, patientId));
  const today = istDateString(now);
  const horizon = toIsoDate(addDays(parseIsoDate(today), 365));
  const byCode = new Map(card.rows.map((r) => [r.code, r.item]));
  return {
    patient: {
      name: card.patient.name,
      nameHi: card.patient.nameHi,
      dob: card.patient.dob,
      sex: card.patient.sex,
      uhid: card.patient.uhid,
      guardian: pt?.guardian ?? null,
      mobileLast4: mobileLast4(card.patient.mobile),
    },
    scheduleName: card.scheduleName,
    given: card.given.map((g) => {
      const item = g.itemCode ? byCode.get(g.itemCode) : undefined;
      return {
        label: item
          ? { hi: item.labelHi, en: item.label }
          : { hi: g.vaccineName, en: g.vaccineName },
        date: g.givenOn,
        brand: g.brand,
        batchNo: g.batchNo,
        expiry: g.expiry,
        site: g.site,
      };
    }),
    pending: outstandingDoses(card.rows)
      .filter((r) => !r.item.isOptional || r.dueDate! <= horizon)
      .map((r) => ({
        label: { hi: r.item.labelHi, en: r.item.label },
        dueDate: r.dueDate!,
        overdue: r.status === 'overdue',
        optional: r.item.isOptional,
      })),
    nextDue: card.nextDueDate,
  };
}

/** `/print/vaccination-card/<patient id>`: A5 card with batches and what is still due (OPD-06). */
const vaccinationCard = impl<VaccinationData>({
  meta: metaOf(VACCINATION_CARD_TEMPLATE),
  load: ({ db, facilityId, entityId }) => vaccinationData(db, facilityId, entityId),
  body: (data, pm) => <VaccinationCard data={data} meta={pm} />,
});

/** `/print/vaccination-certificate/<patient id>`: the doses given, for signature and stamp. */
const vaccinationCertificate = impl<VaccinationData>({
  meta: metaOf(VACCINATION_CERTIFICATE_TEMPLATE),
  load: ({ db, facilityId, entityId }) => vaccinationData(db, facilityId, entityId),
  body: (data, pm) => <VaccinationCertificate data={data} meta={pm} />,
});

/** `/print/growth-chart/<patient id>`: WHO charts with the child's points (OPD-06). */
const growthChart = impl<GrowthChartData>({
  meta: metaOf(GROWTH_CHART_TEMPLATE),
  async load({ db, facilityId, entityId }) {
    let v;
    try {
      v = await getGrowthOverview(db, { facilityId, userId: '' }, entityId, new Date());
    } catch {
      return null;
    }
    return {
      patient: {
        name: v.patient.name,
        nameHi: v.patient.nameHi,
        dob: v.patient.dob,
        sex: v.patient.sex,
        uhid: v.patient.uhid,
      },
      charts: v.charts,
      rows: [...v.measurements]
        .sort((a, b) => a.measuredOn.localeCompare(b.measuredOn))
        .map((m) => ({
          date: m.measuredOn,
          weightKg: m.weightKg,
          lengthHeightCm: m.lengthHeightCm,
          headCircCm: m.headCircCm,
          zWfa: m.zScores.wfa,
          zLhfa: m.zScores.lhfa,
          zHcfa: m.zScores.hcfa,
          zWfh: m.zScores.wfh,
        })),
    };
  },
  body: (data, pm) => <GrowthChartSheet data={data} meta={pm} />,
});

const IMPLS = new Map<string, TemplateImpl<unknown>>(
  [
    ...sampleTemplates,
    opdSheet,
    patientSticker,
    uhidCard,
    receipt,
    receiptA5,
    dayCloseSlip,
    facilityClose,
    ancCard,
    vaccinationCard,
    vaccinationCertificate,
    growthChart,
  ].map((t) => [t.meta.key, t]),
);

/** Facility profile + `print.header` + `ui.accentColor`, shaped for the header component. */
export async function loadPrintHeader(q: Queryable, facilityId: string): Promise<PrintHeaderData> {
  const [f] = await q.select().from(facility).where(eq(facility.id, facilityId)).limit(1);
  const s = await readSettings(q, facilityId, ['print.header', 'ui.accentColor']);
  const h = s['print.header'];
  const addressEn = [f?.address, f?.district, f?.state, f?.pincode].filter(Boolean).join(', ');
  const regs: PrintHeaderData['registrationNos'] = [];
  if (h.showRegistrationNos) {
    if (f?.clinicalEstablishmentRegNo) {
      regs.push({ label: L.clinicalEstablishmentRegNo, value: f.clinicalEstablishmentRegNo });
    }
    if (f?.gstin) regs.push({ label: L.gstin, value: f.gstin });
  }
  return {
    nameEn: f?.name ?? '',
    nameHi: h.nameHi,
    taglineEn: h.taglineEn,
    taglineHi: h.taglineHi,
    addressEn,
    addressHi: h.addressHi,
    phone: f?.phone ?? '',
    email: f?.email ?? '',
    registrationNos: regs,
    footerNoteEn: h.footerNoteEn,
    footerNoteHi: h.footerNoteHi,
    accent: s['ui.accentColor'],
  };
}

export const getTemplateMeta = findTemplateMeta;

/** True when `entityId` is something this template can print for the facility. */
export async function printEntityExists(
  input: Pick<PrepareInput, 'db' | 'facilityId' | 'template' | 'entityId'>,
): Promise<boolean> {
  const t = IMPLS.get(input.template);
  if (!t) return false;
  return (
    (await t.load({ db: input.db, facilityId: input.facilityId, entityId: input.entityId })) !==
    null
  );
}

export interface PrepareInput {
  db: Queryable;
  facilityId: string;
  template: string;
  entityId: string;
  copyNo: number;
  printedAt: Date;
  printedByName: string;
}

/**
 * Builds the document for one print, or null when the template or entity does not exist (for
 * this facility). Permission checks and `print_log` are the caller's job.
 */
export async function preparePrintDocument(input: PrepareInput): Promise<PrintDocument | null> {
  const t = IMPLS.get(input.template);
  if (!t) return null;
  const data = await t.load({
    db: input.db,
    facilityId: input.facilityId,
    entityId: input.entityId,
  });
  if (data === null) return null;
  const header = await loadPrintHeader(input.db, input.facilityId);
  const docRef = t.qr ? t.qr(data, input.entityId) : input.entityId;
  const meta: PrintMeta = {
    copyNo: input.copyNo,
    printedAt: input.printedAt,
    printedBy: initials(input.printedByName),
    docRef,
    qrSvg: await qrSvg(docRef),
  };
  return {
    template: t.meta,
    header,
    meta,
    body: t.body(data, meta, header),
    stamp: t.stamp?.(data) ?? null,
  };
}
