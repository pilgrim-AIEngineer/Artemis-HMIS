import type { Permission } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { KeyRound, Monitor, ShieldCheck, UserCog, Users } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ComponentType } from 'react';
import { StatusPanel } from '@/components/status-panel';
import { requirePageSession } from '@/server/auth/page-session';

interface Tile {
  href: string;
  key: 'users' | 'roles' | 'workstations' | 'account';
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  permission?: Permission;
}

const TILES: Tile[] = [
  { href: '/admin/users', key: 'users', icon: Users, permission: 'admin.users.manage' },
  { href: '/admin/roles', key: 'roles', icon: ShieldCheck, permission: 'admin.roles.manage' },
  {
    href: '/admin/workstations',
    key: 'workstations',
    icon: Monitor,
    permission: 'admin.settings.manage',
  },
  { href: '/account', key: 'account', icon: UserCog },
];

/**
 * Home: large action tiles for what this user may do (docs/05 §1.1). Role homes for
 * reception/billing/etc. arrive with their modules (FND-06 onwards).
 */
export default async function HomePage() {
  const auth = await requirePageSession();
  const t = await getTranslations('home');
  const tiles = TILES.filter((x) => !x.permission || auth.permissions.has(x.permission));
  const onlyAccount = tiles.length === 1;
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

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map(({ href, key, icon: Icon }) => (
          <li key={key}>
            <Link
              href={href}
              className="flex h-full min-h-28 items-start gap-4 rounded-lg border-2 bg-card p-5 outline-none hover:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/60"
            >
              <Icon aria-hidden className="mt-1 size-8 shrink-0 text-primary" />
              <span className="space-y-1">
                <span className="block text-xl font-semibold">{t(`tiles.${key}`)}</span>
                <span className="block text-muted-foreground">{t(`tiles.${key}Hint`)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {onlyAccount && <p className="text-muted-foreground">{t('noTiles')}</p>}

      <StatusPanel />
    </div>
  );
}
