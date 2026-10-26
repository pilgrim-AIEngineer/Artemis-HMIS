import { notFound } from 'next/navigation';
import { PatientTimeline } from '@/components/timeline/patient-timeline';
import { requirePagePermission } from '@/server/auth/page-session';

/** One patient's timeline (OPD-07); what shows is filtered again on the server by permission. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission('patient.view');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <PatientTimeline patientId={id} />;
}
