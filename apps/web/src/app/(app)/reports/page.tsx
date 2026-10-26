import { canSeeGroup, REPORT_KEYS, REPORT_PERMISSION } from '@hmis/shared';
import { Activity, Baby, ChartColumn, HandCoins, Percent, Syringe } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TileGrid, type Tile } from '@/components/tile-grid';
import { requirePageSession } from '@/server/auth/page-session';

const ICONS = {
  collection: HandCoins,
  opd: Activity,
  anc: Baby,
  vaccines: Syringe,
  adjustments: Percent,
} as const;

/**
 * Reports home (RPT-01, RPT-02): one tile per report the user may open, plus the owner dashboard.
 * Cosmetic guard; each report page and procedure checks its permission again.
 */
export default async function Page() {
  const auth = await requirePageSession();
  if (!canSeeGroup('reports', auth.permissions)) notFound();
  const t = await getTranslations('reports');
  const tiles: Tile[] = [];
  if (auth.permissions.has('reports.owner_dashboard')) {
    tiles.push({
      href: '/reports/dashboard',
      title: t('tiles.dashboard.title'),
      hint: t('tiles.dashboard.hint'),
      icon: ChartColumn,
    });
  }
  for (const key of REPORT_KEYS) {
    if (!auth.permissions.has(REPORT_PERMISSION[key])) continue;
    tiles.push({
      href: `/reports/${key}`,
      title: t(`tiles.${key}.title`),
      hint: t(`tiles.${key}.hint`),
      icon: ICONS[key],
    });
  }
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="text-lg text-muted-foreground">{t('hint')}</p>
      </div>
      <TileGrid tiles={tiles} />
    </div>
  );
}
