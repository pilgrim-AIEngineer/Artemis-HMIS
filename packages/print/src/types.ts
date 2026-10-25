import type { Permission } from '@hmis/shared';
import type { ReactNode } from 'react';
import type { PaperSize } from './paper';

export interface Bilingual {
  hi: string;
  en: string;
}

/** Hospital header lines (docs/05 §6): facility profile + `print.header` setting. */
export interface PrintHeaderData {
  nameEn: string;
  nameHi: string;
  taglineEn: string;
  taglineHi: string;
  addressEn: string;
  addressHi: string;
  phone: string;
  email: string;
  registrationNos: { label: Bilingual; value: string }[];
  footerNoteEn: string;
  footerNoteHi: string;
  /** `#rrggbb` brand accent for rules; null = neutral black. */
  accent: string | null;
}

/** Per-print facts shown in the footer and used for the DUPLICATE mark. */
export interface PrintMeta {
  /** 1 = original; > 1 = reprint, marked DUPLICATE. */
  copyNo: number;
  printedAt: Date;
  /** Initials of the user who printed, e.g. `AS`. */
  printedBy: string;
  /** Encoded in the QR code (the document id). */
  docRef: string;
  /** Inline `<svg>` of the QR code. */
  qrSvg: string;
}

/** Client-safe description of a template (the permission is enforced by the server). */
export interface PrintTemplateMeta {
  key: string;
  paper: PaperSize;
  /** `print_log.entity` and `document.entity` for this template. */
  entity: string;
  /** Needed to print (and to render a PDF of) this template. */
  permission: Permission;
  title: Bilingual;
}

/** Everything needed to draw one printed document; same input for web print and worker PDF. */
export interface PrintDocument {
  template: PrintTemplateMeta;
  header: PrintHeaderData;
  meta: PrintMeta;
  body: ReactNode;
}
