import { notFound } from 'next/navigation';
import { PatientForm } from '@/components/reception/patient-form';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission('patient.update');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <PatientForm patientId={id} />;
}
