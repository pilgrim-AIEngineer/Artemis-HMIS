'use client';

import { Button } from '@hmis/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { Section } from '@/components/section';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

/**
 * Admin → Waiting-room TV (REG-05): creates the long random key in the TV's address. Only a hash
 * is stored, so the full link is shown once, right after it is made; making a new one switches
 * the old link off at once.
 */
export function DisplayLink() {
  const t = useTranslations('admin.display');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const status = useQuery(trpc.queue.displayStatus.queryOptions());
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const rotate = useMutation(
    trpc.queue.rotateDisplayKey.mutationOptions({
      onSuccess: ({ key }) => {
        setError(null);
        setConfirm(false);
        setCopied(false);
        setLink(`${window.location.origin}/display/queue?key=${encodeURIComponent(key)}`);
        void qc.invalidateQueries({ queryKey: trpc.queue.displayStatus.queryKey() });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const configured = status.data?.configured ?? false;
  // Replacing a working link needs a second click, so the TV is not switched off by accident.
  const make = () => {
    if (configured && !link && !confirm) setConfirm(true);
    else rotate.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline">
          <Link href="/admin">
            <ArrowLeft aria-hidden />
            {t('back')}
          </Link>
        </Button>
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
      </div>
      <p className="max-w-3xl text-muted-foreground">{t('help')}</p>

      <Section title={t('linkTitle')}>
        <p role="status" data-testid="display-configured">
          {status.isPending ? '…' : configured ? t('configured') : t('notConfigured')}
        </p>
        {confirm && (
          <p role="alert" className="font-medium text-destructive">
            {t('replaceWarning')}
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <Button onClick={make} disabled={rotate.isPending || status.isPending}>
            <KeyRound aria-hidden />
            {confirm ? t('confirmReplace') : configured ? t('replace') : t('create')}
          </Button>
          {confirm && (
            <Button variant="outline" onClick={() => setConfirm(false)}>
              {t('cancel')}
            </Button>
          )}
        </div>
        <FormStatus error={error} />
        {link && (
          <div
            className="space-y-2 rounded-lg border-2 border-money p-4"
            data-testid="display-link"
          >
            <p className="font-medium">{t('shownOnce')}</p>
            <input
              readOnly
              value={link}
              aria-label={t('linkLabel')}
              className="w-full rounded-md border bg-background p-2 font-mono text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => setCopied(true));
              }}
            >
              <Copy aria-hidden />
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
        )}
      </Section>

      <Section title={t('optionsTitle')}>
        <p className="text-muted-foreground">{t('optionsHelp')}</p>
        <Button asChild variant="outline">
          <Link href="/admin/settings">{t('openSettings')}</Link>
        </Button>
      </Section>
    </div>
  );
}
