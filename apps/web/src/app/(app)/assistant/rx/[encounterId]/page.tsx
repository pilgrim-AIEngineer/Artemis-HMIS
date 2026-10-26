import { uuidSchema } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { RxScreenLoader } from '@/components/rx/rx-screen';
import { requirePagePermission } from '@/server/auth/page-session';

/** Rx transcription screen for one visit (OPD-02 … OPD-04). The URL carries the visit id only. */
export default async function Page({ params }: { params: Promise<{ encounterId: string }> }) {
  await requirePagePermission('rx.transcribe');
  const { encounterId } = await params;
  if (!uuidSchema.safeParse(encounterId).success) notFound();
  return <RxScreenLoader encounterId={encounterId} />;
}
