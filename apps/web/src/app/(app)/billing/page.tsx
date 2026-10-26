import { canSeeGroup } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { BillingDesk } from '@/components/billing/billing-desk';
import { GroupHome } from '@/components/group-home';
import { requirePageSession } from '@/server/auth/page-session';

/**
 * Billing home: the desk of bills waiting for money (BIL-01). Users of the billing group without
 * OPD billing (e.g. IPD-only, later) still get the group landing page. Cosmetic guard; the
 * procedures check `billing.*` again.
 */
export default async function Page() {
  const auth = await requirePageSession();
  if (!canSeeGroup('billing', auth.permissions)) notFound();
  if (!auth.permissions.has('billing.bill.create')) return <GroupHome group="billing" />;
  return <BillingDesk />;
}
