import { getTranslations } from 'next-intl/server';
import { AccountForms } from '@/components/account/account-forms';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { requirePageSession } from '@/server/auth/page-session';

export default async function AccountPage() {
  await requirePageSession();
  const t = await getTranslations('account');
  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-semibold">{t('title')}</h1>
      <section aria-labelledby="lang-title" className="space-y-3 rounded-lg border bg-card p-5">
        <h2 id="lang-title" className="text-xl font-semibold">
          {t('language.title')}
        </h2>
        <LocaleSwitcher signedIn />
      </section>
      <AccountForms />
    </div>
  );
}
