import { notFound } from 'next/navigation';
import { PatientSummary } from '@/components/reception/patient-summary';
import { requirePagePermission } from '@/server/auth/page-session';

export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ registered?: string }>;
}) {
  await requirePagePermission('patient.view');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { registered } = await searchParams;
  return (
    <PatientSummary
      id={id}
      registeredUhid={/^[A-Z0-9]{1,12}-\d{4,12}$/.test(registered ?? '') ? registered : undefined}
    />
  );
}
