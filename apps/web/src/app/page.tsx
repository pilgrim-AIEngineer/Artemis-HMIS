import { getTranslations } from 'next-intl/server';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { StatusPanel } from '@/components/status-panel';

export default async function HomePage() {
  const t = await getTranslations('app');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <span className="text-lg font-bold tracking-tight">{t('name')}</span>
          <LocaleSwitcher />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-6 py-10">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold">{t('title')}</h1>
          <p className="text-lg text-muted-foreground">{t('subtitle')}</p>
        </div>
        <StatusPanel />
      </main>
    </div>
  );
}
