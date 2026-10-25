/**
 * Billable services (docs/33 §2). Names only: the hospital enters every rate (docs/40 Q6/Q7), and a
 * service without a rate cannot be added to a bill (docs/12 §1). Healthcare services are GST
 * exempt (SAC 9993, docs/12 §7.5; the CA confirms before go-live), so the seed sets
 * `isExempt` with a 0 rate. USG and lab services are generated from their masters.
 */
import type { ServiceCategory } from '@hmis/shared';

export interface ServiceSeed {
  code: string;
  name: string;
  nameHi: string;
  category: ServiceCategory;
  /** Department code (docs/33 §1). */
  dept: string;
  unit?: 'per_visit' | 'per_day' | 'per_hour' | 'per_unit';
  shortCode?: string;
}

const s = (
  category: ServiceCategory,
  dept: string,
  code: string,
  name: string,
  nameHi: string,
  unit: ServiceSeed['unit'] = 'per_visit',
  shortCode?: string,
): ServiceSeed => ({ code, name, nameHi, category, dept, unit, shortCode });

export const SERVICES: readonly ServiceSeed[] = [
  // Consultation
  s(
    'consultation',
    'GYN',
    'CONS-GYN-NEW',
    'Gynae consultation – new',
    'स्त्री रोग परामर्श – नया',
    'per_visit',
    'GN',
  ),
  s(
    'consultation',
    'GYN',
    'CONS-GYN-FU',
    'Gynae consultation – follow-up',
    'स्त्री रोग परामर्श – फ़ॉलो-अप',
    'per_visit',
    'GF',
  ),
  s('consultation', 'GYN', 'CONS-ANC', 'ANC visit', 'गर्भावस्था जाँच (एएनसी)', 'per_visit', 'ANC'),
  s(
    'consultation',
    'GYN',
    'CONS-EMG',
    'Emergency consultation',
    'आपातकालीन परामर्श',
    'per_visit',
    'EMG',
  ),
  s(
    'consultation',
    'PAED',
    'CONS-PAED-NEW',
    'Paeds consultation – new',
    'बाल रोग परामर्श – नया',
    'per_visit',
    'PN',
  ),
  s(
    'consultation',
    'PAED',
    'CONS-PAED-FU',
    'Paeds consultation – follow-up',
    'बाल रोग परामर्श – फ़ॉलो-अप',
    'per_visit',
    'PF',
  ),
  s('consultation', 'PAED', 'CONS-VACC', 'Vaccination visit', 'टीकाकरण विज़िट', 'per_visit', 'VAC'),
  s(
    'consultation',
    'GYN',
    'CONS-NIGHT',
    'Night consultation',
    'रात्रि परामर्श',
    'per_visit',
    'NGT',
  ),
  // Procedures (OPD)
  s('procedure', 'GYN', 'PROC-PAP', 'Pap smear', 'पैप स्मीयर', 'per_unit', 'PAP'),
  s('procedure', 'GYN', 'PROC-IUCD-INS', 'IUCD insertion', 'आईयूसीडी लगाना', 'per_unit', 'IUI'),
  s('procedure', 'GYN', 'PROC-IUCD-REM', 'IUCD removal', 'आईयूसीडी निकालना', 'per_unit', 'IUR'),
  s(
    'procedure',
    'GYN',
    'PROC-CONTRA-ADM',
    'Implant / contraceptive injection administration',
    'इम्प्लांट / गर्भनिरोधक इंजेक्शन लगाना',
    'per_unit',
  ),
  s('procedure', 'GYN', 'PROC-DRESS-S', 'Dressing – small', 'ड्रेसिंग – छोटी', 'per_unit'),
  s('procedure', 'GYN', 'PROC-DRESS-L', 'Dressing – large', 'ड्रेसिंग – बड़ी', 'per_unit'),
  s('procedure', 'GYN', 'PROC-SUTURE-REM', 'Suture removal', 'टाँके निकालना', 'per_unit'),
  s(
    'procedure',
    'GYN',
    'PROC-INJ',
    'Injection charge (IM/IV)',
    'इंजेक्शन शुल्क (आईएम/आईवी)',
    'per_unit',
    'INJ',
  ),
  s('procedure', 'GYN', 'PROC-IV-CANN', 'IV cannulation', 'आईवी कैनुला', 'per_unit'),
  s('procedure', 'PAED', 'PROC-NEB', 'Nebulisation', 'नेबुलाइज़ेशन', 'per_unit', 'NEB'),
  s('procedure', 'GYN', 'PROC-NST', 'NST / CTG', 'एनएसटी / सीटीजी', 'per_unit', 'NST'),
  s(
    'procedure',
    'GYN',
    'PROC-VAG-EXAM',
    'Vaginal examination / speculum',
    'योनि परीक्षण / स्पेकुलम',
    'per_unit',
  ),
  s('procedure', 'GYN', 'PROC-COLPO', 'Colposcopy', 'कोल्पोस्कोपी', 'per_unit'),
  s('procedure', 'PAED', 'PROC-EAR-PIERCE', 'Ear piercing', 'कान छेदना', 'per_unit'),
  s('procedure', 'PAED', 'PROC-CIRCUM', 'Circumcision', 'खतना', 'per_unit'),
  // IPD
  s(
    'bed',
    'GYN',
    'BED-DAY',
    'Bed charge (per day; rate by room category)',
    'बिस्तर शुल्क (प्रति दिन; कमरे की श्रेणी अनुसार)',
    'per_day',
  ),
  s(
    'nursing',
    'GYN',
    'NURSING-DAY',
    'Nursing charge (per day)',
    'नर्सिंग शुल्क (प्रति दिन)',
    'per_day',
  ),
  s('doctor_visit', 'GYN', 'RMO-DAY', 'RMO charge (per day)', 'आरएमओ शुल्क (प्रति दिन)', 'per_day'),
  s('doctor_visit', 'GYN', 'CONSULTANT-VISIT', 'Consultant visit', 'कंसल्टेंट विज़िट', 'per_visit'),
  s('equipment', 'GYN', 'MONITOR-DAY', 'Monitor (per day)', 'मॉनिटर (प्रति दिन)', 'per_day'),
  s('equipment', 'GYN', 'OXYGEN-HR', 'Oxygen (per hour)', 'ऑक्सीजन (प्रति घंटा)', 'per_hour'),
  s(
    'equipment',
    'PAED',
    'BABY-WARMER-DAY',
    'Baby warmer (per day)',
    'बेबी वार्मर (प्रति दिन)',
    'per_day',
  ),
  s(
    'equipment',
    'PAED',
    'PHOTOTHERAPY-DAY',
    'Phototherapy (per day)',
    'फोटोथेरेपी (प्रति दिन)',
    'per_day',
  ),
  s('icu', 'PAED', 'NICU-DAY', 'NICU (per day)', 'एनआईसीयू (प्रति दिन)', 'per_day'),
  // OT / labour room
  s('ot', 'GYN', 'OT-MINOR', 'OT charges – minor', 'ओटी शुल्क – माइनर', 'per_unit'),
  s('ot', 'GYN', 'OT-MAJOR', 'OT charges – major', 'ओटी शुल्क – मेजर', 'per_unit'),
  s('ot', 'GYN', 'LR-CHARGE', 'Labour room charges', 'लेबर रूम शुल्क', 'per_unit'),
  s('ot', 'GYN', 'SURGEON-FEE', 'Surgeon fee', 'सर्जन फीस', 'per_unit'),
  s('ot', 'GYN', 'ASSISTANT-FEE', 'Assistant fee', 'सहायक फीस', 'per_unit'),
  s('ot', 'ANES', 'ANAESTHETIST-FEE', 'Anaesthetist fee', 'निश्चेतक फीस', 'per_unit'),
  s(
    'ot',
    'PAED',
    'PAED-AT-DELIVERY',
    'Paediatrician at delivery',
    'प्रसव के समय बाल रोग विशेषज्ञ',
    'per_unit',
  ),
];
