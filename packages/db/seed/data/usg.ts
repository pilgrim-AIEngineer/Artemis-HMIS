/**
 * USG procedure master (docs/33 §2–3). Form F gating (`requiresFormFIfPregnant`) defaults to
 * true for every scan a pregnant woman can have, which is the legally safe side; only the
 * neonatal scan, whose patient is a newborn, is exempt. The doctor / Appropriate Authority
 * guidance may relax this in the masters UI (see PR notes).
 */
import type { UsgCategory } from '@hmis/shared';

export interface UsgProcedureSeed {
  code: string;
  name: string;
  nameHi: string;
  category: UsgCategory;
  requiresFormFIfPregnant: boolean;
}

export const USG_PROCEDURES: readonly UsgProcedureSeed[] = [
  {
    code: 'OB-EARLY',
    name: 'Obstetric USG – early',
    nameHi: 'प्रसूति यूएसजी – प्रारंभिक',
    category: 'obstetric',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'NT',
    name: 'NT scan',
    nameHi: 'एनटी स्कैन',
    category: 'obstetric',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'ANOMALY',
    name: 'Anomaly scan (level II)',
    nameHi: 'एनोमली स्कैन (लेवल II)',
    category: 'obstetric',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'GROWTH',
    name: 'Growth scan',
    nameHi: 'ग्रोथ स्कैन',
    category: 'obstetric',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'OB-DOPPLER',
    name: 'Obstetric Doppler',
    nameHi: 'प्रसूति डॉप्लर',
    category: 'doppler',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'PELVIS-TAS',
    name: 'Pelvis – transabdominal (TAS)',
    nameHi: 'पेल्विस – पेट के ऊपर से (टीएएस)',
    category: 'pelvis',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'PELVIS-TVS',
    name: 'Pelvis – transvaginal (TVS)',
    nameHi: 'पेल्विस – योनि मार्ग से (टीवीएस)',
    category: 'pelvis',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'FOLLICULAR',
    name: 'Follicular study (per visit)',
    nameHi: 'फॉलिक्युलर स्टडी (प्रति विज़िट)',
    category: 'follicular',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'ABDOMEN',
    name: 'Abdomen',
    nameHi: 'पेट (एब्डोमेन)',
    category: 'abdomen',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'BREAST',
    name: 'Breast',
    nameHi: 'स्तन (ब्रेस्ट)',
    category: 'other',
    requiresFormFIfPregnant: true,
  },
  {
    code: 'NEO-CRANIAL',
    name: 'Neonatal cranial',
    nameHi: 'नवजात कपाल',
    category: 'other',
    requiresFormFIfPregnant: false,
  },
];
