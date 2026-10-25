/**
 * STARTER drug list so Rx transcription works on a fresh install (docs/33 §7). It is NOT the
 * hospital's formulary: the real list (top ~300 drugs from two weeks of OPD sheets, or the
 * pharmacy's export) is imported by MIG-01. Names are generic; brands are added from that import.
 * `schedule` is 'none' and GST/HSN are blank on purpose: legal classification (Schedule H/H1/X,
 * H1 register, docs/15) and tax rates must be set by the pharmacist before the pharmacy module
 * goes live. Nothing here is a clinical recommendation.
 */
import type { DrugForm } from '@hmis/shared';

export interface DrugSeed {
  name: string;
  strength: string | null;
  form: DrugForm;
  shortCode?: string;
}

const d = (
  name: string,
  form: DrugForm,
  strength: string | null,
  shortCode?: string,
): DrugSeed => ({
  name,
  form,
  strength,
  shortCode,
});

export const STARTER_DRUGS: readonly DrugSeed[] = [
  d('Paracetamol', 'tab', '500 mg', 'PCM'),
  d('Paracetamol', 'tab', '650 mg'),
  d('Paracetamol', 'syp', '125 mg/5 mL'),
  d('Paracetamol', 'drops', '100 mg/mL'),
  d('Ibuprofen', 'tab', '400 mg'),
  d('Diclofenac', 'tab', '50 mg'),
  d('Mefenamic acid', 'tab', '500 mg'),
  d('Drotaverine', 'tab', '40 mg'),
  d('Amoxicillin', 'cap', '500 mg'),
  d('Amoxicillin + clavulanic acid', 'tab', '625 mg'),
  d('Azithromycin', 'tab', '500 mg'),
  d('Cefixime', 'tab', '200 mg'),
  d('Cefixime', 'syp', '50 mg/5 mL'),
  d('Ceftriaxone', 'inj', '1 g'),
  d('Metronidazole', 'tab', '400 mg'),
  d('Nitrofurantoin', 'cap', '100 mg'),
  d('Fluconazole', 'tab', '150 mg'),
  d('Clotrimazole', 'pessary', '100 mg'),
  d('Clotrimazole', 'cream', '1%'),
  d('Pantoprazole', 'tab', '40 mg'),
  d('Domperidone', 'tab', '10 mg'),
  d('Ondansetron', 'tab', '4 mg'),
  d('Doxylamine + pyridoxine', 'tab', null),
  d('Iron + folic acid', 'tab', null, 'IFA'),
  d('Folic acid', 'tab', '5 mg'),
  d('Calcium + vitamin D3', 'tab', null, 'CAL'),
  d('Vitamin B-complex', 'cap', null),
  d('Vitamin D3', 'sachet', '60000 IU'),
  d('Multivitamin', 'drops', null),
  d('Progesterone (micronised)', 'cap', '200 mg'),
  d('Dydrogesterone', 'tab', '10 mg'),
  d('Tranexamic acid', 'tab', '500 mg'),
  d('Misoprostol', 'tab', '200 mcg'),
  d('Oxytocin', 'inj', '5 IU/mL'),
  d('Cetirizine', 'tab', '10 mg'),
  d('Levocetirizine', 'tab', '5 mg'),
  d('Salbutamol', 'inhaler', '100 mcg'),
  d('Oral rehydration salts', 'sachet', null, 'ORS'),
  d('Zinc', 'tab', '20 mg'),
  d('Lactulose', 'syp', '10 g/15 mL'),
];
