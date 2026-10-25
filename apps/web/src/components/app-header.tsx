'use client';

import { Button } from '@hmis/ui/components/button';
import { Globe, Lock, Monitor, UserRoundCog } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useSession } from './auth/session-provider';
import { LocaleSwitcher } from './locale-switcher';

/** Top bar of every signed-in screen: who, where, Lock and the always-visible Switch user. */
export function AppHeader() {
  const t = useTranslations('auth.header');
  const tApp = useTranslations('app');
  const { me, lock, switchUser } = useSession();
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link href="/" className="text-lg font-bold tracking-tight">
            {tApp('name')}
          </Link>
          <span className="font-medium" data-testid="current-user">
            {me.fullName}
          </span>
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <Monitor aria-hidden className="size-4" />
            {me.workstationName ? t('workstation', { name: me.workstationName }) : t('notPaired')}
          </span>
          {me.isRemote && (
            <span className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-sm font-medium">
              <Globe aria-hidden className="size-4" />
              {t('remote')}
            </span>
          )}
        </div>
        <nav className="flex flex-wrap items-center gap-2">
          <LocaleSwitcher signedIn />
          <Button asChild variant="ghost">
            <Link href="/account">{t('account')}</Link>
          </Button>
          <Button variant="outline" onClick={lock}>
            <Lock aria-hidden />
            {t('lock')}
          </Button>
          <Button variant="outline" onClick={switchUser}>
            <UserRoundCog aria-hidden />
            {t('switchUser')}
          </Button>
        </nav>
      </div>
    </header>
  );
}
