import { canSeeGroup } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { BillingDesk } from '@/components/billing/billing-desk';
import { DayCloseLinks } from '@/components/day-close/day-close-links';
import { GroupHome } from '@/components/group-home';
import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/server/auth/page-session';

/**
 * Billing home: the desk of bills waiting for money (BIL-01) with the day-end links (BIL-06).
 * Users of the billing group without OPD billing (e.g. admin with the facility close, IPD-only
 * later) get the links or the group landing page. Cosmetic guard; the procedures check
 * `billing.*` again.
 */
export default async function Page() {
  const auth = await requirePageSession();
  if (!canSeeGroup('billing', auth.permissions)) notFound();
  const links = (
    <DayCloseLinks
      own={auth.permissions.has('billing.dayclose.own')}
      facility={auth.permissions.has('billing.dayclose.facility')}
    />
  );
  if (!auth.permissions.has('billing.bill.create')) {
    const dayEnd =
      auth.permissions.has('billing.dayclose.own') ||
      auth.permissions.has('billing.dayclose.facility');
    if (!dayEnd) return <GroupHome group="billing" />;
    const t = await getTranslations('dayClose');
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold">{t('billingHome')}</h1>
        {links}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {links}
      <BillingDesk />
    </div>
  );
}
