'use client';

import { buildInstruction } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { WarningText } from './warning-text';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useAgeText } from '@/lib/use-age-text';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

/**
 * Doctor verification queue (docs/11 §2.7, `rx.verifyMode`, Q15): the paper photo side by side
 * with the typed Rx, oldest first; one tap verifies. The handwritten sheet stays the original;
 * this checks the transcription of it.
 */
export function VerificationQueue() {
  const t = useTranslations('rx');
  const tQ = useTranslations('queue');
  const locale = useLocale();
  const ageText = useAgeText();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queue = useQuery(trpc.rx.verificationQueue.queryOptions());
  const [error, setError] = useState<string | null>(null);
  const verify = useMutation(
    trpc.rx.verify.mutationOptions({
      onSuccess: () => {
        setError(null);
        void queryClient.invalidateQueries({ queryKey: trpc.rx.verificationQueue.queryKey() });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('verify.title')}</h1>
        <p className="text-lg text-muted-foreground">{t('verify.hint')}</p>
      </div>
      <FormStatus error={error} />
      {queue.isError && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('loadFailed')}
        </p>
      )}
      {queue.data && queue.data.length === 0 && (
        <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
          {t('verify.none')}
        </p>
      )}
      <ul className="space-y-6">
        {queue.data?.map((q) => (
          <li
            key={q.prescriptionId}
            className="grid gap-4 rounded-lg border-2 bg-card p-4 lg:grid-cols-2"
            data-testid="rx-verify-item"
          >
            <div className="space-y-2">
              <p className="text-xl font-semibold">
                {locale === 'hi' && q.nameHi ? q.nameHi : q.fullName}
              </p>
              <p className="text-muted-foreground">
                {ageText(q.dob)} / {tQ(`sex.${q.sex as 'F' | 'M' | 'O'}`)} · {q.uhid} ·{' '}
                {t('verify.typedBy', { name: q.enteredByName })}
              </p>
              {q.scanDocumentId ? (
                // eslint-disable-next-line @next/next/no-img-element -- session-checked API image
                <img
                  src={`/api/documents/rx-scan/${q.scanDocumentId}`}
                  alt={t('scan.alt')}
                  className="max-h-[60vh] w-full rounded-lg border object-contain"
                />
              ) : (
                <p className="rounded-lg border-2 border-dashed p-4">{t('verify.noPhoto')}</p>
              )}
            </div>
            <div className="space-y-3">
              <ol className="space-y-2">
                {q.items.map((i, n) => (
                  <li key={n} className="rounded-md border p-2">
                    <p className="text-lg font-semibold">
                      {n + 1}. {i.drugName}
                    </p>
                    <p lang="hi">{i.instructionsHi ?? buildInstruction(i, 'hi')}</p>
                    {i.quantity !== null && (
                      <p className="text-sm text-muted-foreground">
                        {t('med.qtyShort', { n: i.quantity })}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              {q.warnings.length > 0 && (
                <ul className="space-y-1">
                  {q.warnings.map((w) => (
                    <li
                      key={`${w.code}-${w.row}`}
                      className="rounded-md border-2 border-amber-600 bg-amber-50 px-3 py-1 text-amber-950"
                    >
                      ▲ {w.row + 1}. <WarningText warning={w} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground">{t('verify.correctHint')}</p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="lg"
                  disabled={verify.isPending}
                  onClick={() => verify.mutate({ prescriptionId: q.prescriptionId })}
                >
                  <CheckCircle2 aria-hidden />
                  {t('verify.verify')}
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
