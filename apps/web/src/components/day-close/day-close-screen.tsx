'use client';

import {
  closeVariance,
  countedCashPaise,
  formatDate,
  formatDateTime,
  formatINR,
  istDateString,
  NOTE_DENOMINATIONS,
  parseRupeeText,
  type Denominations,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { ConfirmMoneyDialog } from '@hmis/ui/components/confirm-money-dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { MoneyInput } from '@hmis/ui/components/money-input';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type KeyboardEvent } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { PrintButton } from '@/components/print/print-button';
import { PrintOnMount } from '@/components/print/print-on-mount';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { amountWords, DifferenceText, ModeTiles, signedINR } from './parts';

type Counts = Record<(typeof NOTE_DENOMINATIONS)[number], string>;
const EMPTY_COUNTS: Counts = { 500: '', 200: '', 100: '', 50: '', 20: '', 10: '' };

/** Whole non-negative number from a count field's text; empty = 0. */
const toCount = (s: string): number => (s === '' ? 0 : Number.parseInt(s, 10));

interface Done {
  dayCloseId: string;
  cashCountedPaise: string;
  differencePaise: string;
}

/**
 * Day-end close of the cashier's own counter (BIL-06, docs/12 §6): what the system expects for
 * cash, UPI and card since the last close, a denomination counter for the cash in the drawer,
 * the difference (a reason is required when it is not zero), and a confirmation. Enter moves to
 * the next count field; the last Enter reaches the close button. The close slip prints when done.
 */
export function DayCloseScreen() {
  const t = useTranslations('dayClose');
  const locale = useLocale() === 'hi' ? 'hi' : 'en';
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const counter = useQuery(
    trpc.dayClose.counter.queryOptions(undefined, { refetchOnWindowFocus: true }),
  );
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [coins, setCoins] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const fields = useRef<(HTMLInputElement | null)[]>([]);
  // One key per distinct request: a retry of the same close replays, a changed count is new.
  const attempt = useRef<{ sig: string; key: string } | null>(null);

  const open = counter.data?.open;
  const recent = counter.data?.recent ?? [];
  const den: Denominations = {
    n500: toCount(counts[500]),
    n200: toCount(counts[200]),
    n100: toCount(counts[100]),
    n50: toCount(counts[50]),
    n20: toCount(counts[20]),
    n10: toCount(counts[10]),
    coinsPaise: parseRupeeText(coins) ?? 0n,
  };
  const counted = countedCashPaise(den);
  const expected = open?.totals.cashPaise ?? 0n;
  const variance = closeVariance(expected, counted);
  const reasonMissing = variance.reasonRequired && reason.trim().length < 3;

  const closeOwn = useMutation(
    trpc.dayClose.closeOwn.mutationOptions({
      onSuccess: (r) => {
        setConfirming(false);
        setDone(r);
        void qc.invalidateQueries({ queryKey: trpc.dayClose.counter.queryKey() });
      },
      onError: (e) => {
        setError(errorText(e));
        // The expected figure moved (a payment came in while counting): show the new one.
        void qc.invalidateQueries({ queryKey: trpc.dayClose.counter.queryKey() });
      },
    }),
  );

  const submit = () => {
    if (!open || closeOwn.isPending) return;
    const input = {
      denominations: {
        n500: den.n500,
        n200: den.n200,
        n100: den.n100,
        n50: den.n50,
        n20: den.n20,
        n10: den.n10,
        coinsPaise: den.coinsPaise.toString(),
      },
      expectedCashPaise: expected.toString(),
      differenceReason: variance.reasonRequired ? reason.trim() : undefined,
    };
    const sig = JSON.stringify(input);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() };
    setError(null);
    closeOwn.mutate({ ...input, idempotencyKey: attempt.current.key });
  };

  const next = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const target = fields.current[i + 1];
    if (target) target.focus();
    else document.getElementById('close-submit')?.focus();
  };

  if (counter.isPending)
    return <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />;
  if (!open) return <FormStatus error={errorText(counter.error)} />;

  if (done) {
    return (
      <div className="space-y-5">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <section
          className="space-y-3 rounded-lg border-2 border-money p-4"
          role="status"
          data-testid="close-done"
        >
          <p className="flex items-center gap-2 text-2xl font-semibold">
            <CheckCircle2 aria-hidden className="size-7 text-money" />
            {t('done', { counted: formatINR(BigInt(done.cashCountedPaise)) })}
          </p>
          <p className="text-lg">
            {t('differenceIs')}{' '}
            <DifferenceText paise={BigInt(done.differencePaise)} testId="done-difference" />
          </p>
          <PrintOnMount key={done.dayCloseId} template="day-close" entityId={done.dayCloseId} />
          <PrintButton
            template="day-close"
            entityId={done.dayCloseId}
            label={t('printSlip')}
            variant="outline"
            shortcut={false}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="text-lg text-muted-foreground" data-testid="close-period">
          {open.lastClosedAt
            ? t('since', { at: formatDateTime(open.lastClosedAt) })
            : t('sinceStart')}{' '}
          · {t('paymentCount', { count: open.paymentCount })}
        </p>
        <p
          className="text-lg"
          data-testid="close-business-date"
          data-date={open.closeDate}
          data-next-day={open.closeDate > istDateString(new Date()) ? 'true' : 'false'}
        >
          {open.closeDate > istDateString(new Date())
            ? t('nextDayNote', { date: formatDate(open.closeDate) })
            : t('businessDateLine', { date: formatDate(open.closeDate) })}
        </p>
      </div>

      <ModeTiles totals={open.totals} />

      <section aria-labelledby="count-h" className="space-y-3">
        <h2 id="count-h" className="text-xl font-semibold">
          {t('countCash')}
        </h2>
        <div className="max-w-xl overflow-hidden rounded-lg border bg-card">
          <table className="w-full" data-testid="denominations">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-2">{t('note')}</th>
                <th className="px-4 py-2">{t('count')}</th>
                <th className="px-4 py-2 text-right">{t('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {NOTE_DENOMINATIONS.map((v, i) => (
                <tr key={v} className="border-b last:border-0">
                  <th scope="row" className="px-4 py-2 text-left text-lg font-semibold">
                    ₹{v}
                  </th>
                  <td className="px-4 py-2">
                    <Input
                      ref={(el) => {
                        fields.current[i] = el;
                      }}
                      inputMode="numeric"
                      autoFocus={i === 0}
                      autoComplete="off"
                      aria-label={t('countOf', { value: v })}
                      data-testid={`count-${v}`}
                      className="w-28 text-right text-lg tabular-nums"
                      value={counts[v]}
                      onChange={(e) => {
                        const s = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
                        if (s.length <= 6) setCounts((c) => ({ ...c, [v]: s }));
                      }}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={next(i)}
                    />
                  </td>
                  <td className="px-4 py-2 text-right text-lg tabular-nums">
                    {formatINR(BigInt(toCount(counts[v])) * BigInt(v) * 100n)}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="px-4 py-2 text-left text-lg font-semibold">
                  {t('coins')}
                </th>
                <td className="px-4 py-2" colSpan={2}>
                  <MoneyInput
                    ref={(el: HTMLInputElement | null) => {
                      fields.current[NOTE_DENOMINATIONS.length] = el;
                    }}
                    aria-label={t('coinsTotal')}
                    data-testid="count-coins"
                    value={coins}
                    onChange={setCoins}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={next(NOTE_DENOMINATIONS.length)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="result-h" className="max-w-xl space-y-3" aria-live="polite">
        <h2 id="result-h" className="sr-only">
          {t('result')}
        </h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-lg">
          <dt>{t('expectedCash')}</dt>
          <dd className="text-right tabular-nums" data-testid="expected-cash-line">
            {formatINR(expected)}
          </dd>
          <dt className="font-semibold">{t('countedCash')}</dt>
          <dd className="text-right text-3xl font-bold tabular-nums" data-testid="counted-cash">
            {formatINR(counted)}
          </dd>
          <dt className="font-semibold">{t('difference')}</dt>
          <dd className="text-right text-2xl">
            <DifferenceText paise={variance.differencePaise} testId="difference" />
          </dd>
        </dl>
        {variance.reasonRequired && (
          <div className="space-y-2">
            <Label htmlFor="difference-reason">{t('reasonLabel')}</Label>
            <Input
              id="difference-reason"
              data-testid="difference-reason"
              maxLength={200}
              value={reason}
              placeholder={t('reasonPlaceholder')}
              aria-invalid={reasonMissing || undefined}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        <FormStatus error={error} />
        <Button
          id="close-submit"
          size="lg"
          data-testid="close-submit"
          disabled={reasonMissing || closeOwn.isPending}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {t('closeCounter')}
        </Button>
      </section>

      <ConfirmMoneyDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle')}
        amountText={formatINR(counted)}
        words={amountWords(counted, locale)}
        confirmLabel={t('confirmClose')}
        cancelLabel={t('back')}
        closeLabel={t('back')}
        onConfirm={submit}
        pending={closeOwn.isPending}
        error={error}
      >
        <p className="text-lg" data-testid="confirm-summary">
          {t('confirmSummary', {
            expected: formatINR(expected),
            difference: signedINR(variance.differencePaise),
          })}
        </p>
      </ConfirmMoneyDialog>

      {recent.length > 0 && (
        <section aria-labelledby="recent-h" className="max-w-3xl space-y-2">
          <h2 id="recent-h" className="text-xl font-semibold">
            {t('recent')}
          </h2>
          <ul className="divide-y rounded-lg border bg-card" data-testid="recent-closes">
            {recent.map((c) => (
              <li
                key={c.id}
                className={cn('flex flex-wrap items-center justify-between gap-3 px-4 py-3')}
              >
                <div>
                  <p className="font-semibold">{formatDateTime(c.closedAt)}</p>
                  <p className="text-muted-foreground">
                    {t('recentLine', {
                      counted: formatINR(c.cashCountedPaise),
                      difference: signedINR(c.differencePaise),
                    })}
                  </p>
                </div>
                <PrintButton
                  template="day-close"
                  entityId={c.id}
                  label={t('printSlip')}
                  variant="outline"
                  shortcut={false}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
