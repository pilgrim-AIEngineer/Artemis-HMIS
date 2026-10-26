import { istDateString } from '@hmis/shared';
import { UpiReconciliationScreen } from '@/components/day-close/upi-reconciliation-screen';
import { requirePagePermission } from '@/server/auth/page-session';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Daily UPI reconciliation (BIL-06). The procedures check `billing.dayclose.facility` again. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePagePermission('billing.dayclose.facility');
  const { date } = await searchParams;
  return (
    <UpiReconciliationScreen
      initialDate={typeof date === 'string' && DATE.test(date) ? date : istDateString(new Date())}
    />
  );
}
