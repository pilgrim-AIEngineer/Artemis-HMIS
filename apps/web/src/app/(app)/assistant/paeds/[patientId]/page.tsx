import { uuidSchema } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { PaedsRecord } from '@/components/paeds/paeds-record';
import { requirePagePermission } from '@/server/auth/page-session';

/** One child's vaccination and growth card (OPD-06). */
export default async function Page({ params }: { params: Promise<{ patientId: string }> }) {
  const auth = await requirePagePermission('patient.view');
  const { patientId } = await params;
  if (!uuidSchema.safeParse(patientId).success) notFound();
  return (
    <PaedsRecord patientId={patientId} canEdit={auth.permissions.has('clinical.paeds.edit')} />
  );
}
