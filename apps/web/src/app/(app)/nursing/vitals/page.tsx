import { VitalsDesk } from '@/components/vitals/vitals-desk';
import { requirePagePermission } from '@/server/auth/page-session';

/** Vitals desk list (OPD-01). Cosmetic guard; `vitals.*` procedures check again. */
export default async function Page() {
  await requirePagePermission('vitals.record');
  return <VitalsDesk />;
}
