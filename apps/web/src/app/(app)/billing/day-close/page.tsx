import { DayCloseScreen } from '@/components/day-close/day-close-screen';
import { requirePagePermission } from '@/server/auth/page-session';

/** A cashier closes their own counter (BIL-06). The procedures check `billing.dayclose.own` again. */
export default async function Page() {
  await requirePagePermission('billing.dayclose.own');
  return <DayCloseScreen />;
}
