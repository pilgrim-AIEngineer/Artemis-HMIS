import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LoginFlow, type LoginStep } from '@/components/auth/login-flow';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { getPageSession } from '@/server/auth/page-session';

const NOTICES = ['pinLockedOut', 'signedOut'] as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getPageSession();
  if (auth && (auth.state === 'active' || auth.state === 'locked')) redirect('/');
  const step: LoginStep =
    auth?.state === 'mfa_pending'
      ? 'totp'
      : auth?.state === 'password_change'
        ? 'password'
        : 'credentials';
  const raw = (await searchParams).notice;
  const notice = NOTICES.find((n) => n === raw) ?? null;
  const t = await getTranslations('app');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <span className="text-lg font-bold tracking-tight">{t('name')}</span>
          <LocaleSwitcher />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
        <p className="mb-6 text-center text-xl text-muted-foreground">{t('title')}</p>
        <LoginFlow initialStep={step} notice={notice} />
      </main>
    </div>
  );
}
