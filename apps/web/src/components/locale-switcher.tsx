'use client';

import { LOCALES, type Locale } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setLocale } from '@/app/actions';
import { useTRPC } from '@/trpc/client';

/**
 * Language buttons. Signed in, the choice is saved as the user's language (docs/05 §1.8:
 * per-user); on the login screen it only sets the browser cookie.
 */
export function LocaleSwitcher({ signedIn = false }: { signedIn?: boolean }) {
  const t = useTranslations('language');
  const current = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const [pending, startTransition] = useTransition();
  const save = useMutation(trpc.auth.setLanguage.mutationOptions());

  const choose = (locale: Locale) =>
    startTransition(async () => {
      if (signedIn) await save.mutateAsync({ locale });
      else await setLocale(locale);
      router.refresh();
    });

  return (
    <div role="group" aria-label={t('label')} className="flex gap-2">
      {LOCALES.map((locale) => (
        <Button
          key={locale}
          variant={locale === current ? 'secondary' : 'ghost'}
          aria-pressed={locale === current}
          lang={locale}
          disabled={pending}
          onClick={() => choose(locale)}
        >
          {t(locale)}
        </Button>
      ))}
    </div>
  );
}
