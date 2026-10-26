import { FacilityCloseScreen } from '@/components/day-close/facility-close-screen';
import { requirePagePermission } from '@/server/auth/page-session';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Admin / owner close the facility day (BIL-06). The procedures check the permission again. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePagePermission('billing.dayclose.facility');
  const { date } = await searchParams;
  return (
    <FacilityCloseScreen
      initialDate={typeof date === 'string' && DATE.test(date) ? date : undefined}
    />
  );
}
