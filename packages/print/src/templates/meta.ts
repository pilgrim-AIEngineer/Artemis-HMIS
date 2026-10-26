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
};

/** All print templates, client-safe. Add real templates here and in `server.tsx`. */
export const PRINT_TEMPLATE_METAS: readonly PrintTemplateMeta[] = [
  ...SAMPLE_METAS,
  OPD_SHEET,
  PATIENT_STICKER,
  UHID_CARD,
  RECEIPT,
];

export const findTemplateMeta = (key: string): PrintTemplateMeta | undefined =>
  PRINT_TEMPLATE_METAS.find((t) => t.key === key);
