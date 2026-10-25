/** docs/33 §1. CARD stays inactive until Phase 3 (cardiologist joins). */
export interface DepartmentSeed {
  code: string;
  name: string;
  nameHi: string;
  isClinical: boolean;
  isActive: boolean;
}

export const DEPARTMENTS: readonly DepartmentSeed[] = [
  {
    code: 'GYN',
    name: 'Obstetrics & Gynaecology',
    nameHi: 'प्रसूति एवं स्त्री रोग',
    isClinical: true,
    isActive: true,
  },
  { code: 'PAED', name: 'Paediatrics', nameHi: 'बाल रोग', isClinical: true, isActive: true },
  {
    code: 'RAD',
    name: 'Radiology / USG',
    nameHi: 'रेडियोलॉजी / यूएसजी',
    isClinical: false,
    isActive: true,
  },
  { code: 'PATH', name: 'Pathology', nameHi: 'पैथोलॉजी', isClinical: false, isActive: true },
  { code: 'PHARM', name: 'Pharmacy', nameHi: 'फार्मेसी', isClinical: false, isActive: true },
  {
    code: 'ANES',
    name: 'Anaesthesia',
    nameHi: 'निश्चेतना (एनेस्थीसिया)',
    isClinical: true,
    isActive: true,
  },
  { code: 'CARD', name: 'Cardiology', nameHi: 'हृदय रोग', isClinical: true, isActive: false },
];
