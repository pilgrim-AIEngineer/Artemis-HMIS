/**
 * Lab test list for orders (docs/33 §6). Names and departments only: units, methods, sample
 * types and reference ranges are for the pathologist to enter (docs/32 §5). Multi-analyte tests
 * (CBC, LFT, lipid, urine) are `text` until panel/analyte tables arrive with LAB-01.
 */
import type { LabDepartment } from '@hmis/shared';

export interface LabTestSeed {
  code: string;
  name: string;
  department: LabDepartment;
  resultType: 'numeric' | 'text';
}

const t = (
  department: LabDepartment,
  code: string,
  name: string,
  resultType: 'numeric' | 'text' = 'numeric',
): LabTestSeed => ({ code, name, department, resultType });

export const LAB_TESTS: readonly LabTestSeed[] = [
  t('haematology', 'HB', 'Haemoglobin (Hb)'),
  t('haematology', 'CBC', 'Complete blood count (CBC)', 'text'),
  t('haematology', 'ESR', 'ESR'),
  t('haematology', 'ABO-RH', 'Blood group & Rh', 'text'),
  t('haematology', 'BT-CT', 'Bleeding time / clotting time', 'text'),
  t('haematology', 'PT-INR', 'PT / INR'),
  t('haematology', 'APTT', 'APTT'),
  t('haematology', 'PBS', 'Peripheral smear', 'text'),
  t('haematology', 'MALARIA', 'Malaria antigen / smear', 'text'),
  t('biochemistry', 'RBS', 'Random blood sugar (RBS)'),
  t('biochemistry', 'FBS', 'Fasting blood sugar (FBS)'),
  t('biochemistry', 'PPBS', 'Post-prandial blood sugar (PPBS)'),
  t('biochemistry', 'OGTT', 'OGTT (75 g, 0/1/2 h)', 'text'),
  t('biochemistry', 'HBA1C', 'HbA1c'),
  t('biochemistry', 'UREA', 'Urea'),
  t('biochemistry', 'CREAT', 'Creatinine'),
  t('biochemistry', 'URIC', 'Uric acid'),
  t('biochemistry', 'ELECTROLYTES', 'Electrolytes (Na, K, Cl)', 'text'),
  t('biochemistry', 'LFT', 'Liver function test (LFT)', 'text'),
  t('biochemistry', 'LIPID', 'Lipid profile', 'text'),
  t('biochemistry', 'CALCIUM', 'Calcium'),
  t('biochemistry', 'CRP', 'CRP'),
  t('serology', 'HIV', 'HIV I & II', 'text'),
  t('serology', 'HBSAG', 'HBsAg', 'text'),
  t('serology', 'HCV', 'HCV', 'text'),
  t('serology', 'VDRL', 'VDRL / RPR', 'text'),
  t('serology', 'WIDAL', 'Widal', 'text'),
  t('serology', 'DENGUE', 'Dengue NS1 / IgM', 'text'),
  t('serology', 'TYPHIDOT', 'Typhidot', 'text'),
  t('serology', 'RA', 'RA factor', 'text'),
  t('serology', 'ASO', 'ASO titre', 'text'),
  t('serology', 'UPT', 'Urine pregnancy test (UPT)', 'text'),
  t('serology', 'BHCG', 'Beta-hCG (quantitative)'),
  t('hormones', 'TSH', 'TSH'),
  t('hormones', 'FT3-FT4', 'FT3 / FT4', 'text'),
  t('hormones', 'PRL', 'Prolactin'),
  t('hormones', 'FSH', 'FSH'),
  t('hormones', 'LH', 'LH'),
  t('hormones', 'AMH', 'AMH'),
  t('hormones', 'VITD', 'Vitamin D'),
  t('hormones', 'B12', 'Vitamin B12'),
  t('clin_path', 'URINE-RM', 'Urine routine / microscopy', 'text'),
  t('clin_path', 'URINE-CULTURE', 'Urine culture', 'text'),
  t('clin_path', 'STOOL-RM', 'Stool routine', 'text'),
];
