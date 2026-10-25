import { PatientForm } from '@/components/reception/patient-form';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function NewPatientPage({
  searchParams,
}: {
  searchParams: Promise<{ familyOf?: string }>;
}) {
  await requirePagePermission('patient.create');
  const { familyOf } = await searchParams;
  return <PatientForm familyOf={/^[0-9a-f-]{36}$/i.test(familyOf ?? '') ? familyOf : undefined} />;
}
