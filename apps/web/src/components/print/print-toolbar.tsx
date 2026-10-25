'use client';

import { Button } from '@hmis/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useShortcut } from '@/lib/use-shortcut';
import { PrintButton } from './print-button';

/** Screen-only bar above the preview: Print (`Ctrl+P`) and Back (`Esc`). Hidden when printing. */
export function PrintToolbar({
  template,
  entityId,
  title,
  shownCopy,
  nextCopy,
}: {
  template: string;
  entityId: string;
  title: string;
  /** Set when the page shows an already logged copy. */
  shownCopy: number | null;
  nextCopy: number;
}) {
  const t = useTranslations('print');
  const router = useRouter();
  const back = () => (window.history.length > 1 ? router.back() : router.push('/'));
  useShortcut('Escape', back);
  return (
    <div className="no-print border-b bg-card">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {shownCopy !== null
              ? t('showingCopy', { n: shownCopy })
              : nextCopy > 1
                ? t('nextIsDuplicate', { n: nextCopy })
                : t('nextIsOriginal')}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button variant="outline" onClick={back}>
            <ArrowLeft aria-hidden />
            {t('back')}
            <ShortcutHint keys="Esc" />
          </Button>
          <PrintButton template={template} entityId={entityId} />
        </div>
      </div>
    </div>
  );
}
