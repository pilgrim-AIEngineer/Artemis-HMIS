import { canSeeGroup } from '@hmis/shared';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ADMIN_TILES, TileGrid } from '@/components/tile-grid';
import { requirePageSession } from '@/server/auth/page-session';

/**
 * Administration home: users, roles, facility profile, settings, print header, workstations.
 * Anyone holding any `admin.*` key opens it and sees only the tiles they may use.
 */
export default async function AdminHomePage() {
  const auth = await requirePageSession();
  if (!canSeeGroup('admin', auth.permissions)) notFound();
  const t = await getTranslations('home');
  const tNav = await getTranslations('nav.groups');
  const tiles = ADMIN_TILES.filter((x) =>
    [x.permission].flat().some((p) => auth.permissions.has(p)),
  ).map((x) => ({
    href: x.href,
    title: t(`tiles.${x.key}`),
    hint: t(`tiles.${x.key}Hint`),
    icon: x.icon,
  }));
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{tNav('admin')}</h1>
      <TileGrid tiles={tiles} />
    </div>
  );
}
