'use client';

import { amountInWords, formatINR, totalOfModes, type ModeTotals } from '@hmis/shared';
import { cn } from '@hmis/ui/lib/utils';
import { useTranslations } from 'next-intl';

/** `+₹50.00` / `−₹50.00` / `₹0.00`: the sign says which way the cash is off. */
export const signedINR = (paise: bigint) =>
  paise === 0n
    ? formatINR(0n)
    : `${paise > 0n ? '+' : '−'}${formatINR(paise < 0n ? -paise : paise)}`;

/** Amount in words in the user's language (docs/05 §2). */
export const amountWords = (paise: bigint, locale: 'en' | 'hi') => amountInWords(paise, locale);

/** The difference of a close: green at zero, red when cash is short, amber when over. */
export function DifferenceText({ paise, testId }: { paise: bigint; testId?: string }) {
  const t = useTranslations('dayClose');
  return (
    <span
      data-testid={testId}
      className={cn(
        'font-bold tabular-nums',
        paise === 0n ? 'text-money' : paise < 0n ? 'text-destructive' : 'text-amber-700',
      )}
    >
      {signedINR(paise)}
      {paise < 0n && <span className="ml-2 text-base font-semibold">{t('short')}</span>}
      {paise > 0n && <span className="ml-2 text-base font-semibold">{t('over')}</span>}
    </span>
  );
}

/** Expected cash / UPI / card (and the total) as large tiles. */
export function ModeTiles({ totals }: { totals: ModeTotals }) {
  const t = useTranslations('dayClose');
  const tiles: [string, bigint][] = [
    ['cash', totals.cashPaise],
    ['upi', totals.upiPaise],
    ['card', totals.cardPaise],
  ];
  return (
    <section aria-label={t('expected')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map(([mode, paise]) => (
        <div key={mode} className="rounded-lg border bg-card p-4" data-testid={`expected-${mode}`}>
          <p className="text-muted-foreground">{t(`mode.${mode as 'cash' | 'upi' | 'card'}`)}</p>
          <p className="text-3xl font-bold tabular-nums">{formatINR(paise)}</p>
        </div>
      ))}
      <div className="rounded-lg border-2 bg-card p-4" data-testid="expected-total">
        <p className="text-muted-foreground">{t('total')}</p>
        <p className="text-3xl font-bold tabular-nums">{formatINR(totalOfModes(totals))}</p>
      </div>
    </section>
  );
}
