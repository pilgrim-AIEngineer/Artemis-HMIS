import { canSeeGroup } from '@hmis/shared';
import { HeartPulse } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TileGrid } from '@/components/tile-grid';
import { requirePageSession } from '@/server/auth/page-session';

/** Nursing home: the vitals desk first (OPD-01); ward screens join with the IPD modules. */
export default async function Page() {
  const auth = await requirePageSession();
  if (!canSeeGroup('nursing', auth.permissions)) notFound();
  const t = await getTranslations('groups');
  const tNav = await getTranslations('nav.groups');
  const tiles = auth.permissions.has('vitals.record')
    ? [
        {
          href: '/nursing/vitals',
          title: t('nursing.vitalsTitle'),
          hint: t('nursing.vitalsHint'),
          icon: HeartPulse,
        },
      ]
    : [];
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{tNav('nursing')}</h1>
        <p className="text-lg text-muted-foreground">{t('nursing.hint')}</p>
      </div>
      <TileGrid tiles={tiles} />
      <p className="max-w-3xl rounded-lg border-2 bg-card p-6 text-lg">{t('comingSoon')}</p>
    </div>
  );
}
