import type { Bilingual } from './types';

/**
 * Fixed words on printouts, Hindi first and English second (docs/05 §6). Print templates are
 * rendered by the worker without next-intl, so their wording lives here as typed pairs instead of
 * in the web message files.
 */
export const L = {
  duplicate: { hi: 'प्रति', en: 'DUPLICATE' },
  duplicateCopy: { hi: 'डुप्लीकेट प्रति', en: 'Duplicate copy' },
  phone: { hi: 'फ़ोन', en: 'Phone' },
  clinicalEstablishmentRegNo: { hi: 'पंजीकरण सं.', en: 'Reg. No.' },
  pcpndtRegNo: { hi: 'पीसीपीएनडीटी पंजीकरण', en: 'PCPNDT Reg.' },
  gstin: { hi: 'जीएसटीआईएन', en: 'GSTIN' },
  printedOn: { hi: 'मुद्रित', en: 'Printed' },
  by: { hi: 'द्वारा', en: 'by' },
  sampleTitle: { hi: 'नमूना दस्तावेज़', en: 'Sample document' },
  item: { hi: 'विवरण', en: 'Item' },
  qty: { hi: 'मात्रा', en: 'Qty' },
  amount: { hi: 'राशि', en: 'Amount' },
  total: { hi: 'कुल', en: 'Total' },
  sampleNote: {
    hi: 'यह केवल प्रिंट जाँचने के लिए नमूना है। इसमें कोई मरीज़ की जानकारी नहीं है।',
    en: 'This is a layout check only. It holds no patient information.',
  },
  samplePatient: { hi: 'नमूना मरीज़', en: 'Sample Patient' },
  uhid: { hi: 'यूएचआईडी', en: 'UHID' },
} as const satisfies Record<string, Bilingual>;
