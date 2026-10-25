import { notFound } from 'next/navigation';
import { VisitForm } from '@/components/reception/visit-form';
import { requirePagePermission } from '@/server/auth/page-session';

/** New OPD visit for a patient (REG-03). The procedures check `visit.create` again. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission('visit.create');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <VisitForm patientId={id} />;
}
