import { uuidSchema } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { VitalsFormLoader } from '@/components/vitals/vitals-form';
import { requirePagePermission } from '@/server/auth/page-session';

/** Vitals form for one token (OPD-01). */
export default async function Page({ params }: { params: Promise<{ tokenId: string }> }) {
  await requirePagePermission('vitals.record');
  const { tokenId } = await params;
  if (!uuidSchema.safeParse(tokenId).success) notFound();
  return <VitalsFormLoader tokenId={tokenId} />;
}
