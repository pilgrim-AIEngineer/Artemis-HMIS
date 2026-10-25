/**
 * Excel import templates (docs/33 §9). This file is the single definition: `generate.ts` writes
 * the `.xlsx` files from it and a test keeps them in step. The importer itself is MIG-01
 * (dry-run with an error report, then commit in one transaction); these are templates only.
 *
 * Layout of every workbook: sheet `Data` has one header row (machine keys, snake_case) and the
 * hospital's rows below it; sheet `Instructions` explains each column with an example. The
 * importer reads only `Data`. All amounts are in RUPEES here (converted to paise at the edge,
 * AGENTS.md rule 1). Never commit a filled-in template: patient files hold real patient data.
 */
import {
  DRUG_FORMS,
  DRUG_SCHEDULES,
  LAB_DEPARTMENTS,
  LAB_RESULT_TYPES,
  SERVICE_CATEGORIES,
  SERVICE_UNITS,
} from '@hmis/shared';

export interface TemplateColumn {
  key: string;
  required: boolean;
  /** What to enter. */
  help: string;
  /** Allowed values, when the column is an enumeration. */
  allowed?: readonly string[];
  /** A synthetic example shown on the Instructions sheet only. */
  example: string;
}

export interface TemplateSpec {
  file: string;
  title: string;
  /** Roadmap phase in which the importer exists (docs/00). */
  phase: 'P1' | 'P2A' | 'P2B';
  columns: readonly TemplateColumn[];
}

const c = (
  key: string,
  required: boolean,
  help: string,
  example: string,
  allowed?: readonly string[],
): TemplateColumn => ({ key, required, help, example, allowed });

const YES_NO = ['yes', 'no'] as const;

export const TEMPLATES: readonly TemplateSpec[] = [
  {
    file: 'patients.xlsx',
    title: 'Patients (old register / previous software)',
    phase: 'P1',
    columns: [
      c('old_uhid', false, 'Number used in the old system; kept as an identifier', 'OLD-00123'),
      c('first_name', true, 'First name', 'Sunita'),
      c('middle_name', false, 'Middle name', ''),
      c('last_name', false, 'Surname', 'Verma'),
      c('sex', true, 'F, M or O (the patient)', 'F', ['F', 'M', 'O']),
      c('dob', false, 'Date of birth, YYYY-MM-DD. Leave blank if only age is known', '1994-07-01'),
      c(
        'age_years',
        false,
        'Age in years when DOB is unknown (DOB is then marked estimated)',
        '32',
      ),
      c('mobile', true, '10-digit Indian mobile (starts 6–9)', '9000012345'),
      c('relation_to_mobile_owner', false, 'self, wife, daughter, son, mother …', 'self'),
      c('guardian_name', false, 'Husband / father name', 'Ramesh Verma'),
      c('guardian_relation', false, 'Relation of the guardian', 'husband', [
        'husband',
        'father',
        'mother',
        'other',
      ]),
      c('address_line', false, 'House / street', 'Ward 4, Main Road'),
      c('locality', false, 'Village / locality', 'Rampur'),
      c('district', false, 'District', 'Lucknow'),
      c('state', false, 'State', 'Uttar Pradesh'),
      c('pincode', false, '6 digits', '226001'),
      c('blood_group', false, 'e.g. B+', 'B+'),
    ],
  },
  {
    file: 'services_rates.xlsx',
    title: 'Services and rates (rate list)',
    phase: 'P1',
    columns: [
      c('service_code', true, 'Unique code; existing codes are updated', 'CONS-GYN-NEW'),
      c('service_name', true, 'English name (shown on bills)', 'Gynae consultation – new'),
      c('service_name_hi', false, 'Hindi name (shown on bills)', 'स्त्री रोग परामर्श – नया'),
      c('category', true, 'Billing category', 'consultation', SERVICE_CATEGORIES),
      c('department_code', false, 'Department code, e.g. GYN, PAED, RAD', 'GYN'),
      c('unit', false, 'How the rate is counted (default per_visit)', 'per_visit', SERVICE_UNITS),
      c('sac_code', false, 'SAC code; healthcare is 9993 (your CA confirms)', '9993'),
      c('gst_rate_percent', false, 'GST % — 0 for exempt healthcare services', '0'),
      c('tariff_name', true, 'Tariff the rate belongs to', 'Standard (Cash)'),
      c('room_category', false, 'Only for IPD rates that depend on the room', ''),
      c('rate_inr', true, 'Rate in rupees, up to 2 decimals', '500.00'),
      c('effective_from', true, 'First day the rate applies, YYYY-MM-DD', '2026-04-01'),
    ],
  },
  {
    file: 'doctors.xlsx',
    title: 'Doctors and consultation rules',
    phase: 'P1',
    columns: [
      c('display_name', true, 'Name as printed', 'Dr. Sunita Verma'),
      c('display_name_hi', false, 'Hindi name', 'डॉ. सुनीता वर्मा'),
      c('qualifications', false, 'Degrees', 'MBBS, MS (Obstetrics & Gynaecology)'),
      c('department_code', true, 'Department code', 'GYN'),
      c('registration_council', false, 'Medical council', 'UP Medical Council'),
      c('registration_no', false, 'Registration number', 'UPMC-12345'),
      c('is_visiting', false, 'Visiting doctor without a login?', 'no', YES_NO),
      c(
        'opd_days',
        false,
        'Comma separated: mon,tue,wed,thu,fri,sat,sun',
        'mon,tue,wed,thu,fri,sat',
      ),
      c('new_visit_service_code', false, 'Service code billed for a new visit', 'CONS-GYN-NEW'),
      c('follow_up_service_code', false, 'Service code billed for a follow-up', 'CONS-GYN-FU'),
      c(
        'follow_up_validity_days',
        false,
        'Days a follow-up stays valid (blank = hospital default 7)',
        '7',
      ),
      c(
        'free_follow_ups',
        false,
        'Free follow-ups within the validity (blank = hospital default 1)',
        '1',
      ),
    ],
  },
  {
    file: 'drugs.xlsx',
    title: 'Drug master (for prescriptions and pharmacy)',
    phase: 'P1',
    columns: [
      c('brand_name', true, 'Brand / trade name', 'Examplemol'),
      c('generic_name', false, 'Generic (salt) name', 'Paracetamol'),
      c('short_code', false, 'Quick-type code', 'PCM'),
      c('strength', false, 'Strength', '500 mg'),
      c('form', true, 'Dosage form', 'tab', DRUG_FORMS),
      c('manufacturer', false, 'Manufacturer', 'Example Pharma'),
      c('hsn_code', false, 'HSN code (pharmacist/CA)', '3004'),
      c('gst_rate_percent', false, 'GST %', '12'),
      c(
        'schedule',
        false,
        'Legal schedule (pharmacist must set H / H1 / X correctly)',
        'none',
        DRUG_SCHEDULES,
      ),
      c('pack_size', false, 'Pack size', '10 tabs'),
      c('default_dose_text', false, 'Default dose wording', '1 tab twice a day'),
      c('is_stocked', false, 'Sold by the hospital pharmacy?', 'yes', YES_NO),
    ],
  },
  {
    file: 'lab_tests.xlsx',
    title: 'Lab test list',
    phase: 'P1',
    columns: [
      c('code', true, 'Unique code', 'HB'),
      c('name', true, 'Test name', 'Haemoglobin (Hb)'),
      c('department', true, 'Lab section', 'haematology', LAB_DEPARTMENTS),
      c('sample_type', false, 'Sample', 'Blood'),
      c('container', false, 'Container / tube', 'EDTA'),
      c('method', false, 'Method', ''),
      c('unit', false, 'Result unit (pathologist to confirm)', 'g/dL'),
      c(
        'result_type',
        false,
        'How the result is entered (default numeric)',
        'numeric',
        LAB_RESULT_TYPES,
      ),
      c('decimals', false, 'Decimals for numeric results', '1'),
      c('tat_hours', false, 'Turnaround time in hours', '2'),
      c('is_outsourced', false, 'Sent to an outside lab?', 'no', YES_NO),
      c('outsource_lab', false, 'Name of the outside lab', ''),
      c('rate_inr', false, 'Rate in rupees in the Standard tariff', '100.00'),
    ],
  },
  {
    file: 'packages.xlsx',
    title: 'Surgery / delivery packages',
    phase: 'P2A',
    columns: [
      c('package_code', true, 'Unique code', 'PKG-LSCS'),
      c('name', true, 'Package name', 'LSCS package'),
      c('name_hi', false, 'Hindi name', ''),
      c('department_code', false, 'Department code', 'GYN'),
      c('room_category', false, 'Room category, blank = any', 'Semi-private'),
      c('included_days', true, 'Days of stay included', '3'),
      c('tariff_name', true, 'Tariff', 'Standard (Cash)'),
      c('rate_inr', true, 'Package rate in rupees', '45000.00'),
      c(
        'inclusions',
        false,
        'Service codes with caps, e.g. OT-MAJOR:1;SURGEON-FEE:1',
        'OT-MAJOR:1;SURGEON-FEE:1',
      ),
      c(
        'exclusions',
        false,
        'Not included, e.g. blood products; NICU stay',
        'blood products; NICU stay',
      ),
      c('extra_day_service_code', false, 'Service billed for days beyond the package', 'BED-DAY'),
    ],
  },
  {
    file: 'stock_opening.xlsx',
    title: 'Opening stock (pharmacy / store)',
    phase: 'P2A',
    columns: [
      c('store', true, 'Store name', 'Main pharmacy'),
      c('drug_brand_name', true, 'Brand name as in the drug master', 'Examplemol'),
      c('strength', false, 'Strength to tell apart variants', '500 mg'),
      c('batch_no', true, 'Batch number', 'B2301'),
      c('expiry', true, 'Expiry, YYYY-MM-DD (last day of the month)', '2027-12-31'),
      c('quantity', true, 'Quantity in base units (tablets, vials …)', '200'),
      c('purchase_rate_inr', false, 'Purchase rate per unit in rupees', '1.20'),
      c('mrp_inr', false, 'MRP per unit in rupees', '2.00'),
    ],
  },
  {
    file: 'pmjay_hbp_rates.xlsx',
    title: 'PM-JAY Health Benefit Package rates',
    phase: 'P2B',
    columns: [
      c('hbp_code', true, 'HBP procedure code from the SHA package master', 'EXAMPLE-01'),
      c('specialty', false, 'Specialty', 'Obstetrics and Gynaecology'),
      c('procedure_name', true, 'Package name', 'Example package'),
      c('package_rate_inr', true, 'Package rate in rupees', '9000.00'),
      c('pre_auth_required', false, 'Pre-authorisation needed?', 'yes', YES_NO),
      c('stay_days', false, 'Days of stay covered', '3'),
      c(
        'reserved_for_public',
        false,
        'Reserved for public hospitals (not claimable here)?',
        'no',
        YES_NO,
      ),
    ],
  },
];
