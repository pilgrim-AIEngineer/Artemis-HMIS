import { readSetting } from '@hmis/db';
import { ROUTE_GROUPS, readableOn, type RouteGroup } from '@hmis/shared';
import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';
import type { NavLabels } from '@/components/app-nav';
import { SessionProvider } from '@/components/auth/session-provider';
import { MainArea, SkipLink } from '@/components/skip-link';
import { getDb } from '@/server/db';
import { requirePageSession } from '@/server/auth/page-session';
import { loadMeView } from '@/server/trpc/routers/auth';
import en from '../../../messages/en.json';
import hi from '../../../messages/hi.json';

/** Menu labels in both languages: `ui.bilingualLabels` roles see "हिंदी / English". */
const NAV_LABELS = Object.fromEntries(
  ROUTE_GROUPS.map((g) => [g, { en: en.nav.groups[g], hi: hi.nav.groups[g] }]),
) as NavLabels satisfies Record<RouteGroup, unknown>;

/** Signed-in shell: session gate, skip link, header + menu, idle lock (FND-02, FND-06). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requirePageSession();
  const db = getDb();
  const me = await loadMeView(db, auth);
  const accent = await readSetting(db, auth.facilityId, 'ui.accentColor');
  return (
    // key: a different user (switch user) gets a fresh provider and timers.
    <SessionProvider key={me.userId} initial={me}>
      {accent && (
        // Brand accent (docs/05 §4): validated `#rrggbb`, text colour derived for AA contrast.
        <style
          dangerouslySetInnerHTML={{
            __html: `:root{--primary:${accent};--primary-foreground:${readableOn(accent)};--ring:${accent};}`,
          }}
        />
      )}
      <SkipLink />
      <div className="flex min-h-dvh flex-col">
        <AppHeader navLabels={NAV_LABELS} />
        <MainArea>{children}</MainArea>
      </div>
    </SessionProvider>
  );
}
