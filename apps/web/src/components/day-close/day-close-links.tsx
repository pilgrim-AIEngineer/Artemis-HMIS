import { Button } from '@hmis/ui/components/button';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** Links to the day-end screens a user may open (cosmetic: the procedures check permissions). */
export async function DayCloseLinks({ own, facility }: { own: boolean; facility: boolean }) {
  if (!own && !facility) return null;
  const t = await getTranslations('dayClose');
  return (
    <nav aria-label={t('linksLabel')} className="flex flex-wrap gap-3">
      {own && (
        <Button asChild variant="outline" size="lg">
          <Link href="/billing/day-close" data-testid="link-day-close">
            {t('title')}
          </Link>
        </Button>
      )}
      {facility && (
        <>
          <Button asChild variant="outline" size="lg">
            <Link href="/billing/day-close/facility" data-testid="link-facility-close">
              {t('facilityTitle')}
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/billing/upi-reconciliation" data-testid="link-upi-recon">
              {t('upiTitle')}
            </Link>
          </Button>
        </>
      )}
    </nav>
  );
}
