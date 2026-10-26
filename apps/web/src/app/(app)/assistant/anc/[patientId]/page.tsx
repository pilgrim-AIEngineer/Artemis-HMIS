import { uuidSchema } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { AncRecord } from '@/components/anc/anc-record';
import { requirePagePermission } from '@/server/auth/page-session';

/** One woman's ANC card (OPD-05). */
export default async function Page({ params }: { params: Promise<{ patientId: string }> }) {
  const auth = await requirePagePermission('patient.view');
  const { patientId } = await params;
  if (!uuidSchema.safeParse(patientId).success) notFound();
  return (
    <AncRecord
      patientId={patientId}
      canEdit={auth.permissions.has('clinical.anc.edit')}
      canMtp={auth.permissions.has('mtp.register.edit')}
    />
  );
}
