/**
 * Reason codes (docs/04 §2). The discount reasons are from docs/12 §4; the other kinds are
 * neutral starter lists the admin can edit (docs/12 §5, docs/15 stock adjustment).
 */
import type { ReasonKind } from '@hmis/shared';

export interface ReasonSeed {
  kind: ReasonKind;
  code: string;
  label: string;
  labelHi: string;
}

export const REASON_CODES: readonly ReasonSeed[] = [
  { kind: 'discount', code: 'staff', label: 'Staff', labelHi: 'स्टाफ' },
  {
    kind: 'discount',
    code: 'doctor_discretion',
    label: 'Doctor discretion',
    labelHi: 'डॉक्टर के विवेक पर',
  },
  { kind: 'discount', code: 'poor_patient', label: 'Poor patient', labelHi: 'गरीब मरीज़' },
  {
    kind: 'discount',
    code: 'follow_up_concession',
    label: 'Follow-up concession',
    labelHi: 'फ़ॉलो-अप रियायत',
  },
  { kind: 'discount', code: 'other', label: 'Other', labelHi: 'अन्य' },
  { kind: 'cancel', code: 'wrong_entry', label: 'Wrong entry', labelHi: 'गलत प्रविष्टि' },
  { kind: 'cancel', code: 'patient_request', label: 'Patient request', labelHi: 'मरीज़ का अनुरोध' },
  { kind: 'cancel', code: 'duplicate', label: 'Duplicate', labelHi: 'दोहराव' },
  { kind: 'cancel', code: 'other', label: 'Other', labelHi: 'अन्य' },
  {
    kind: 'refund',
    code: 'service_not_done',
    label: 'Service not performed',
    labelHi: 'सेवा नहीं दी गई',
  },
  {
    kind: 'refund',
    code: 'wrong_amount',
    label: 'Wrong amount or mode',
    labelHi: 'गलत राशि या माध्यम',
  },
  { kind: 'refund', code: 'other', label: 'Other', labelHi: 'अन्य' },
  { kind: 'stock_adjust', code: 'damaged', label: 'Damaged', labelHi: 'क्षतिग्रस्त' },
  { kind: 'stock_adjust', code: 'expired', label: 'Expired', labelHi: 'एक्सपायर' },
  {
    kind: 'stock_adjust',
    code: 'count_correction',
    label: 'Count correction',
    labelHi: 'गिनती सुधार',
  },
  { kind: 'stock_adjust', code: 'other', label: 'Other', labelHi: 'अन्य' },
  { kind: 'no_show', code: 'did_not_arrive', label: 'Did not arrive', labelHi: 'नहीं आए' },
  {
    kind: 'no_show',
    code: 'left_unseen',
    label: 'Left without being seen',
    labelHi: 'बिना दिखाए चले गए',
  },
  { kind: 'no_show', code: 'other', label: 'Other', labelHi: 'अन्य' },
];
