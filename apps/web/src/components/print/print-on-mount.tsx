'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { onPrintDone, openPrintFrame } from './print-frame';

/**
 * Prints a document once, as soon as it appears (the OPD sheet after the token or the vitals,
 * docs/10 §7). Same path as the Print button: `print.begin` logs the copy, then a hidden frame
 * opens the print dialog. Mount it with a new `key` to print again.
 */
export function PrintOnMount({ template, entityId }: { template: string; entityId: string }) {
  const t = useTranslations('print');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const begin = useMutation(
    trpc.print.begin.mutationOptions({
      onSuccess: ({ copyNo }) =>
        openPrintFrame(
          `/print/${encodeURIComponent(template)}/${entityId}?copy=${copyNo}&embed=1`,
          t('frameTitle'),
        ),
      onError: (e) => setError(errorText(e)),
    }),
  );
  useEffect(() => onPrintDone(), []);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin.mutate({ template, entityId });
  }, [begin, template, entityId]);
  return error ? (
    <p role="alert" className="font-medium text-destructive">
      {t('autoFailed', { error })}
    </p>
  ) : null;
}
