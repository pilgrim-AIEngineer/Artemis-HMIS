'use client';

import { Button } from '@hmis/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ComponentProps } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useErrorText } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';
import { onPrintDone, openPrintFrame } from './print-frame';

/**
 * Prints `/print/<template>/<id>` (docs/01 §4): logs the print (`print.begin` → copy number),
 * loads that copy in a hidden iframe and opens the browser print dialog. `Ctrl+P` does the same,
 * so the browser's own print command can never skip the log. Silent printing via QZ Tray is a
 * later, per-workstation option.
 */
export function PrintButton({
  template,
  entityId,
  onCopy,
  shortcut = true,
  label,
  variant,
  size,
}: {
  template: string;
  entityId: string;
  /** Called with the copy number once it has been logged. */
  onCopy?: (copyNo: number) => void;
  shortcut?: boolean;
  /** Button text; defaults to "Print". */
  label?: string;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
}) {
  const t = useTranslations('print');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onPrintDone(), []);

  const begin = useMutation(
    trpc.print.begin.mutationOptions({
      onSuccess: ({ copyNo }) => {
        setError(null);
        openPrintFrame(
          `/print/${encodeURIComponent(template)}/${entityId}?copy=${copyNo}&embed=1`,
          t('frameTitle'),
        );
        onCopy?.(copyNo);
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const start = () => {
    if (!begin.isPending) begin.mutate({ template, entityId });
  };
  useShortcut('Ctrl+P', start, shortcut);

  return (
    <div className="space-y-1">
      <Button onClick={start} disabled={begin.isPending} variant={variant} size={size}>
        <Printer aria-hidden />
        {label ?? t('print')}
        {shortcut && <ShortcutHint keys="Ctrl+P" />}
      </Button>
      <FormStatus error={error} />
    </div>
  );
}
