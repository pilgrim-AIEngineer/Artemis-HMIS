'use client';

import { ROUTE_GROUP_DEFS, visibleGroups, type RouteGroup } from '@hmis/shared';
import { cn } from '@hmis/ui/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useSession } from './auth/session-provider';

export type NavLabels = Record<RouteGroup, { en: string; hi: string }>;

/**
 * Main menu: one link per role home the signed-in user may open (docs/01 §2, docs/05 §1.1). It is
 * filtered by permission for tidiness only; every page and procedure checks again on the server.
 * With `ui.bilingualLabels` the label reads `हिंदी / English` (docs/05 §1.8).
 */
export function AppNav({ labels }: { labels: NavLabels }) {
  const t = useTranslations('nav');
  const locale = useLocale() as 'en' | 'hi';
  const pathname = usePathname();
  const { me } = useSession();
  const groups = visibleGroups(me.permissions);
  if (groups.length === 0) return null;
  return (
    <nav aria-label={t('label')} className="border-t">
      <ul className="mx-auto flex w-full max-w-6xl flex-wrap gap-1 px-4 py-1">
        {groups.map((g) => {
          const href = ROUTE_GROUP_DEFS[g].href;
          const current = pathname === href || pathname.startsWith(`${href}/`);
          const l = labels[g];
          return (
            <li key={g}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center rounded-md px-3 text-base font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/60',
                  current &&
                    'bg-secondary text-secondary-foreground underline decoration-2 underline-offset-8',
                )}
              >
                {me.bilingualLabels ? `${l.hi} / ${l.en}` : l[locale]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
