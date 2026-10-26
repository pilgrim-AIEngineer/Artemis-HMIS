/**
 * Server side of printing (web print route and worker `pdf.render`): loads the facility header
 * and the template's data from the database and assembles a `PrintDocument`. Import from
 * `@hmis/print/server`; the client-safe pieces are in `@hmis/print`.
 */
import { readSettings, type Db, type Tx } from '@hmis/db';
import {
  doctorProfile,
  encounter,
  facility,
  locality,
  opdToken,
  patient,
  payer,
} from '@hmis/db/schema';
import { DEFAULT_QUICK_ORDERS, formatDate, visitQrPayload } from '@hmis/shared';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import type { ReactNode } from 'react';
import { L } from './labels';
import { initials, qrSvg } from './doc-utils';
import { SampleDocument } from './templates/sample';
import { ageSex, mobileLast4 } from './templates/format';
import { OpdSheet, type OpdSheetData } from './templates/opd-sheet';
import { PatientSticker, UhidCard, type PatientLabelData } from './templates/patient-labels';
import {
  findTemplateMeta,
  OPD_SHEET_TEMPLATE,
  PATIENT_STICKER_TEMPLATE,
  PRINT_TEMPLATE_METAS,
  UHID_CARD_TEMPLATE,
} from './templates/meta';
import type { PrintDocument, PrintHeaderData, PrintMeta, PrintTemplateMeta } from './types';

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
      // Vitals are recorded by OPD-01; until then the boxes print blank.
      vitals: null,
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

const IMPLS = new Map<string, TemplateImpl<unknown>>(
  [...sampleTemplates, opdSheet, patientSticker, uhidCard].map((t) => [t.meta.key, t]),
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
  return { template: t.meta, header, meta, body: t.body(data, meta, header) };
}
