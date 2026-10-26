import { PAPER_SIZES, type PaperSize } from '../paper';
import { L } from '../labels';
import type { PrintTemplateMeta } from '../types';

/** `sample-a4`, `sample-thermal80`, …: one sample template per paper size (FND-06). */
export const sampleTemplateKey = (paper: PaperSize) => `sample-${paper}`;

const SAMPLE_METAS = (Object.keys(PAPER_SIZES) as PaperSize[]).map((paper): PrintTemplateMeta => ({
  key: sampleTemplateKey(paper),
  paper,
  entity: 'facility',
  permission: 'admin.settings.manage',
  title: L.sampleTitle,
}));

export const OPD_SHEET_TEMPLATE = 'opd-sheet';
export const PATIENT_STICKER_TEMPLATE = 'patient-sticker';
export const UHID_CARD_TEMPLATE = 'uhid-card';
export const RECEIPT_TEMPLATE = 'receipt';
export const RECEIPT_A5_TEMPLATE = 'receipt-a5';
export const DAY_CLOSE_TEMPLATE = 'day-close';
export const FACILITY_CLOSE_TEMPLATE = 'facility-close';
export const ANC_CARD_TEMPLATE = 'anc-card';
export const VACCINATION_CARD_TEMPLATE = 'vaccination-card';
export const VACCINATION_CERTIFICATE_TEMPLATE = 'vaccination-certificate';
export const GROWTH_CHART_TEMPLATE = 'growth-chart';

/** REG-06: A5 sheet per visit; the entity is the encounter. */
const OPD_SHEET: PrintTemplateMeta = {
  key: OPD_SHEET_TEMPLATE,
  paper: 'a5',
  entity: 'encounter',
  permission: 'patient.view',
  title: L.opdSheetTitle,
  chrome: 'compact',
};

/** REG-07: 50×25 mm sticker; the entity is the patient. */
const PATIENT_STICKER: PrintTemplateMeta = {
  key: PATIENT_STICKER_TEMPLATE,
  paper: 'label50x25',
  entity: 'patient',
  permission: 'patient.view',
  title: L.stickerTitle,
  markDuplicate: false,
};

/** REG-07: UHID card, front and back, cut out of an A5 sheet; the entity is the patient. */
const UHID_CARD: PrintTemplateMeta = {
  key: UHID_CARD_TEMPLATE,
  paper: 'a5',
  entity: 'patient',
  permission: 'patient.view',
  title: L.uhidCardTitle,
  chrome: 'none',
  markDuplicate: false,
};

/** BIL-02: payment receipt on the 80 mm roll; the entity is the collection (one receipt number). */
const RECEIPT: PrintTemplateMeta = {
  key: RECEIPT_TEMPLATE,
  paper: 'thermal80',
  entity: 'receipt',
  permission: 'billing.payment.collect',
  title: L.receiptTitle,
  copyFamily: 'receipt',
};

/** BIL-05: the same receipt on A5 (itemised, with signature line); shares the copy counter. */
const RECEIPT_A5: PrintTemplateMeta = {
  key: RECEIPT_A5_TEMPLATE,
  paper: 'a5',
  entity: 'receipt',
  permission: 'billing.payment.collect',
  title: L.receiptTitle,
  copyFamily: 'receipt',
};

/** BIL-06: a cashier's day-close slip on the 80 mm roll; the entity is the user close. */
const DAY_CLOSE: PrintTemplateMeta = {
  key: DAY_CLOSE_TEMPLATE,
  paper: 'thermal80',
  entity: 'day_close',
  permission: 'billing.dayclose.own',
  title: L.dayCloseTitle,
};

/** BIL-06: facility day-close summary for the owner on A4; the entity is the facility close. */
const FACILITY_CLOSE: PrintTemplateMeta = {
  key: FACILITY_CLOSE_TEMPLATE,
  paper: 'a4',
  entity: 'day_close',
  permission: 'billing.dayclose.facility',
  title: L.facilityCloseTitle,
};

/** OPD-05: antenatal card on A5; the entity is the pregnancy. */
const ANC_CARD: PrintTemplateMeta = {
  key: ANC_CARD_TEMPLATE,
  paper: 'a5',
  entity: 'pregnancy',
  permission: 'clinical.anc.edit',
  title: L.ancCardTitle,
  chrome: 'compact',
  markDuplicate: false,
};

/** OPD-06: vaccination card on A5; the entity is the patient. */
const VACCINATION_CARD: PrintTemplateMeta = {
  key: VACCINATION_CARD_TEMPLATE,
  paper: 'a5',
  entity: 'patient',
  permission: 'clinical.paeds.edit',
  title: L.vaccinationCardTitle,
  chrome: 'compact',
  markDuplicate: false,
};

/** OPD-06: certificate of the vaccines given, on A4. */
const VACCINATION_CERTIFICATE: PrintTemplateMeta = {
  key: VACCINATION_CERTIFICATE_TEMPLATE,
  paper: 'a4',
  entity: 'patient',
  permission: 'clinical.paeds.edit',
  title: L.vaccinationCertTitle,
};

/** OPD-06: the WHO growth charts with the child's points, on A4. */
const GROWTH_CHART: PrintTemplateMeta = {
  key: GROWTH_CHART_TEMPLATE,
  paper: 'a4',
  entity: 'patient',
  permission: 'clinical.paeds.edit',
  title: L.growthChartTitle,
  markDuplicate: false,
};

/** All print templates, client-safe. Add real templates here and in `server.tsx`. */
export const PRINT_TEMPLATE_METAS: readonly PrintTemplateMeta[] = [
  ...SAMPLE_METAS,
  OPD_SHEET,
  PATIENT_STICKER,
  UHID_CARD,
  RECEIPT,
  RECEIPT_A5,
  DAY_CLOSE,
  FACILITY_CLOSE,
  ANC_CARD,
  VACCINATION_CARD,
  VACCINATION_CERTIFICATE,
  GROWTH_CHART,
];

export const findTemplateMeta = (key: string): PrintTemplateMeta | undefined =>
  PRINT_TEMPLATE_METAS.find((t) => t.key === key);

/** Template keys that share a copy counter with `meta` (itself included). */
export const copyFamilyKeys = (meta: PrintTemplateMeta): string[] =>
  meta.copyFamily
    ? PRINT_TEMPLATE_METAS.filter((t) => t.copyFamily === meta.copyFamily).map((t) => t.key)
    : [meta.key];
