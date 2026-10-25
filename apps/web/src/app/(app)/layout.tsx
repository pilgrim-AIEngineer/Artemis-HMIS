import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';
import { SessionProvider } from '@/components/auth/session-provider';
import { getDb } from '@/server/db';
import { requirePageSession } from '@/server/auth/page-session';
import { loadMeView } from '@/server/trpc/routers/auth';

/** Signed-in shell: session gate, header with Lock / Switch user, idle lock (FND-02). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requirePageSession();
  const me = await loadMeView(getDb(), auth);
  return (
    // key: a different user (switch user) gets a fresh provider and timers.
    <SessionProvider key={me.userId} initial={me}>
      <div className="flex min-h-dvh flex-col">
        <AppHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
      </div>
    </SessionProvider>
  );
}
