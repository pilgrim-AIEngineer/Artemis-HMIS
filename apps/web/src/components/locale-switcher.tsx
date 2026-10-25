'use client';

import { LOCALES } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setLocale } from '@/app/actions';

export function LocaleSwitcher() {
  const t = useTranslations('language');
  const current = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div role="group" aria-label={t('label')} className="flex gap-2">
      {LOCALES.map((locale) => (
        <Button
          key={locale}
          variant={locale === current ? 'secondary' : 'ghost'}
          aria-pressed={locale === current}
          lang={locale}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await setLocale(locale);
              router.refresh();
            })
          }
        >
          {t(locale)}
        </Button>
      ))}
    </div>
  );
}
