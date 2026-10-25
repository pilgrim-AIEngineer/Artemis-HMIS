import { tariff } from '@hmis/db/schema';
import { uuidSchema } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { MastersNav } from '@/components/masters/masters-nav';
import { RatesList } from '@/components/masters/rates-list';
import { requirePagePermission } from '@/server/auth/page-session';
import { getDb } from '@/server/db';

/** Rates of one tariff. The tariff name is read here so the title needs no extra round trip. */
export default async function TariffRatesPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePagePermission('admin.tariff.manage');
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const [row] = await getDb()
    .select({ name: tariff.name })
    .from(tariff)
    .where(and(eq(tariff.id, id.data), eq(tariff.facilityId, auth.facilityId)));
  if (!row) notFound();
  return (
    <div className="space-y-5">
      <MastersNav permissions={auth.permissions} current="tariffs" />
      <RatesList tariffId={id.data} tariffName={row.name} />
    </div>
  );
}
