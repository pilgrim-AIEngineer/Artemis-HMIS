import { ROUTE_GROUP_DEFS, homeGroupFor, visibleGroups } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { StatusPanel } from '@/components/status-panel';
import {
  ACCOUNT_ICON,
  ADMIN_TILES,
  GROUP_ICONS,
  TileGrid,
  type Tile,
} from '@/components/tile-grid';
import { requirePageSession } from '@/server/auth/page-session';

/**
 * Launcher: large tiles for the work areas this user may open, their own home first (docs/05
 * §1.1, docs/03 §1), then Administration screens and "My account". Cosmetic: pages and procedures
 * check permissions again.
 */
export default async function HomePage() {
  const auth = await requirePageSession();
  const t = await getTranslations('home');
  const tGroups = await getTranslations('groups');
  const tNav = await getTranslations('nav.groups');

  const home = homeGroupFor(auth.roles, auth.permissions);
  const areas = visibleGroups(auth.permissions)
    .filter((g) => g !== 'admin')
    .sort((a, b) => Number(b === home) - Number(a === home));
  const tiles: Tile[] = [
    ...areas.map((g) => ({
      href: ROUTE_GROUP_DEFS[g].href,
      title: tNav(g),
      hint: tGroups(`${g}.hint`),
      icon: GROUP_ICONS[g],
    })),
    ...ADMIN_TILES.filter((x) => auth.permissions.has(x.permission)).map((x) => ({
      href: x.href,
      title: t(`tiles.${x.key}`),
      hint: t(`tiles.${x.key}Hint`),
      icon: x.icon,
    })),
    {
      href: '/account',
      title: t('tiles.account'),
      hint: t('tiles.accountHint'),
      icon: ACCOUNT_ICON,
    },
  ];
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title', { name: auth.fullName })}</h1>
        <p className="text-lg text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!auth.hasPin && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-primary/40 bg-card p-4">
          <p className="flex items-center gap-2 text-lg">
            <KeyRound aria-hidden className="size-6" />
            {t('setPin')}
          </p>
          <Button asChild>
            <Link href="/account#pin">{t('setPinAction')}</Link>
          </Button>
        </div>
      )}

      <TileGrid tiles={tiles} />
      {tiles.length === 1 && <p className="text-muted-foreground">{t('noTiles')}</p>}

      <StatusPanel />
    </div>
  );
}
