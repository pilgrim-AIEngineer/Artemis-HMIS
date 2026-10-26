'use client';

import {
  formatDateTime,
  formatINR,
  matchUpiStatement,
  paiseToRupeeText,
  parseRupeeText,
  parseUpiStatement,
  upiDifference,
  type UpiStatementLine,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { ConfirmMoneyDialog } from '@hmis/ui/components/confirm-money-dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { MoneyInput } from '@hmis/ui/components/money-input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { amountWords, DifferenceText } from './parts';

type View = NonNullable<ReturnType<typeof useUpiView>['data']>;

function useUpiView(date: string) {
  const trpc = useTRPC();
  return useQuery(trpc.dayClose.upi.view.queryOptions({ date }));
}

/**
 * Daily UPI reconciliation (BIL-06, docs/12 §3): the system's UPI total of a business day against
 * the total on the bank / UPI app statement. The cashier ticks the receipts they can see on the
 * statement, or pastes the statement lines (UTR and amount) and lets the screen match them by the
 * last digits of the UTR typed at the counter. A difference needs a reason before the day is
 * completed; a completed day cannot change.
 */
export function UpiReconciliationScreen({ initialDate }: { initialDate: string }) {
  const t = useTranslations('dayClose');
  const [date, setDate] = useState(initialDate);
  const view = useUpiView(date);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold">{t('upiTitle')}</h1>
          <p className="text-lg text-muted-foreground">{t('upiHelp')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="upi-date">{t('businessDate')}</Label>
          <Input
            id="upi-date"
            type="date"
            data-testid="upi-date"
            className="w-48"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
      </div>
      {view.isPending ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />
      ) : view.data ? (
        // Remounted after every save so the form shows what the server holds.
        <UpiForm key={`${date}-${view.dataUpdatedAt}`} date={date} view={view.data} />
      ) : null}
    </div>
  );
}

function UpiForm({ date, view }: { date: string; view: View }) {
  const t = useTranslations('dayClose');
  const locale = useLocale() === 'hi' ? 'hi' : 'en';
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const frozen = view.status === 'reconciled';
  const [ticks, setTicks] = useState<Map<string, string | null>>(
    () => new Map(view.receipts.filter((r) => r.matched).map((r) => [r.paymentId, r.statementUtr])),
  );
  const [total, setTotal] = useState(
    view.statementTotalPaise === null
      ? ''
      : paiseToRupeeText(view.statementTotalPaise).replace(/,/g, ''),
  );
  const [reason, setReason] = useState(view.differenceReason ?? '');
  const [paste, setPaste] = useState('');
  const [matchInfo, setMatchInfo] = useState<{
    matched: number;
    leftReceipts: number;
    leftLines: UpiStatementLine[];
    bad: number;
  } | null>(null);
  const [pastedLines, setPastedLines] = useState<UpiStatementLine[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const attempt = useRef<{ sig: string; key: string } | null>(null);

  const statement = parseRupeeText(total) ?? 0n;
  const difference = upiDifference(view.systemTotalPaise, statement);
  const reasonMissing = difference !== 0n && reason.trim().length < 3;
  const tickedTotal = view.receipts
    .filter((r) => ticks.has(r.paymentId))
    .reduce((s, r) => s + r.amountPaise, 0n);

  const save = useMutation(
    trpc.dayClose.upi.save.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        setSaved(true);
        void qc.invalidateQueries({ queryKey: trpc.dayClose.upi.view.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.dayClose.facility.queryKey() });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );

  const run = (complete: boolean) => {
    if (save.isPending) return;
    const input = {
      date,
      statementTotalPaise: statement.toString(),
      matches: [...ticks].map(([paymentId, statementUtr]) => ({
        paymentId,
        ...(statementUtr ? { statementUtr } : {}),
      })),
      differenceReason: difference !== 0n ? reason.trim() : undefined,
      complete,
    };
    const sig = JSON.stringify(input);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() };
    setError(null);
    setSaved(false);
    save.mutate({ ...input, idempotencyKey: attempt.current.key });
  };

  const matchPasted = () => {
    const parsed = parseUpiStatement(paste);
    const result = matchUpiStatement(
      view.receipts.map((r) => ({ id: r.paymentId, amountPaise: r.amountPaise, upiRef: r.upiRef })),
      parsed.lines,
    );
    setTicks((cur) => {
      const next = new Map(cur);
      for (const m of result.matches) next.set(m.paymentId, m.utr);
      return next;
    });
    setPastedLines(parsed.lines);
    setMatchInfo({
      matched: result.matches.length,
      leftReceipts: result.unmatchedPaymentIds.length,
      leftLines: result.unmatchedLineIndexes.map((i) => parsed.lines[i]!),
      bad: parsed.badLines.length,
    });
  };

  const useLinesTotal = () => {
    const sum = pastedLines.reduce((s, l) => s + l.amountPaise, 0n);
    setTotal(paiseToRupeeText(sum).replace(/,/g, ''));
  };

  return (
    <div className="space-y-6">
      {frozen && (
        <p
          className="flex items-center gap-2 rounded-lg border-2 border-money p-4 text-xl font-semibold"
          role="status"
          data-testid="upi-reconciled"
        >
          <CheckCircle2 aria-hidden className="size-6 text-money" />
          {t('upiReconciled', {
            name: view.reconciledByName ?? '',
            at: view.reconciledAt ? formatDateTime(view.reconciledAt) : '',
          })}
        </p>
      )}

      <section aria-labelledby="receipts-h" className="space-y-2">
        <h2 id="receipts-h" className="text-xl font-semibold">
          {t('upiReceipts')}
        </h2>
        {view.receipts.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-lg">{t('upiNone')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full" data-testid="upi-receipts">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="px-4 py-2">{t('seen')}</th>
                  <th className="px-4 py-2">{t('receipt')}</th>
                  <th className="px-4 py-2">{t('time')}</th>
                  <th className="px-4 py-2 text-right">{t('amount')}</th>
                  <th className="px-4 py-2">{t('utrDigits')}</th>
                  <th className="px-4 py-2">{t('payerName')}</th>
                  <th className="px-4 py-2">{t('counter')}</th>
                  <th className="px-4 py-2">{t('statementUtr')}</th>
                </tr>
              </thead>
              <tbody>
                {view.receipts.map((r) => (
                  <tr key={r.paymentId} className="border-b last:border-0" data-testid="upi-row">
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        className="size-6"
                        disabled={frozen}
                        aria-label={t('tick', { number: r.receiptNumber })}
                        checked={ticks.has(r.paymentId)}
                        onChange={(e) =>
                          setTicks((cur) => {
                            const next = new Map(cur);
                            if (e.target.checked)
                              next.set(r.paymentId, cur.get(r.paymentId) ?? null);
                            else next.delete(r.paymentId);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-4 py-2 font-semibold tabular-nums">{r.receiptNumber}</td>
                    <td className="px-4 py-2">{formatDateTime(r.receivedAt)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatINR(r.amountPaise)}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{r.upiRef ? `…${r.upiRef}` : '—'}</td>
                    <td className="px-4 py-2">{r.upiPayerName ?? ''}</td>
                    <td className="px-4 py-2">{r.receivedByName}</td>
                    <td className="px-4 py-2 tabular-nums">{ticks.get(r.paymentId) ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!frozen && (
        <section aria-labelledby="paste-h" className="max-w-3xl space-y-2">
          <h2 id="paste-h" className="text-xl font-semibold">
            {t('pasteTitle')}
          </h2>
          <p className="text-muted-foreground">{t('pasteHelp')}</p>
          <textarea
            rows={5}
            data-testid="upi-paste"
            aria-label={t('pasteTitle')}
            className="w-full rounded-md border-2 border-input bg-card px-3 py-2 font-mono text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            value={paste}
            placeholder={'412345678901  500.00\n512345678902  1,250.00'}
            onChange={(e) => setPaste(e.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" data-testid="upi-match" onClick={matchPasted}>
              {t('matchByUtr')}
            </Button>
            {pastedLines.length > 0 && (
              <Button type="button" variant="outline" onClick={useLinesTotal}>
                {t('useLinesTotal')}
              </Button>
            )}
          </div>
          {matchInfo && (
            <div aria-live="polite" className="space-y-1" data-testid="upi-match-result">
              <p className="text-lg font-semibold">
                {t('matchResult', { matched: matchInfo.matched, left: matchInfo.leftReceipts })}
              </p>
              {matchInfo.bad > 0 && (
                <p className="text-destructive">{t('badLines', { count: matchInfo.bad })}</p>
              )}
              {matchInfo.leftLines.length > 0 && (
                <p>
                  {t('leftLines', {
                    lines: matchInfo.leftLines
                      .map((l) => `${l.utr} ${formatINR(l.amountPaise)}`)
                      .join(', '),
                  })}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="totals-h" className="max-w-xl space-y-3" aria-live="polite">
        <h2 id="totals-h" className="text-xl font-semibold">
          {t('upiTotals')}
        </h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-lg">
          <dt>{t('systemTotal')}</dt>
          <dd className="text-right tabular-nums" data-testid="upi-system">
            {formatINR(view.systemTotalPaise)}
          </dd>
          <dt>{t('tickedTotal')}</dt>
          <dd className="text-right tabular-nums" data-testid="upi-ticked">
            {formatINR(tickedTotal)}
          </dd>
        </dl>
        <div className="space-y-2">
          <Label htmlFor="upi-statement">{t('statementTotal')}</Label>
          <MoneyInput
            id="upi-statement"
            data-testid="upi-statement"
            size="lg"
            disabled={frozen}
            value={total}
            onChange={setTotal}
            words={statement > 0n ? amountWords(statement, locale) : null}
          />
        </div>
        <p className="text-lg">
          {t('difference')}: <DifferenceText paise={difference} testId="upi-difference" />
        </p>
        {difference !== 0n && (
          <div className="space-y-2">
            <Label htmlFor="upi-reason">{t('reasonLabel')}</Label>
            <Input
              id="upi-reason"
              data-testid="upi-reason"
              maxLength={200}
              disabled={frozen}
              value={reason}
              aria-invalid={reasonMissing || undefined}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        <FormStatus error={confirming ? null : error} success={saved ? t('upiSaved') : null} />
        {!frozen && (
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              variant="outline"
              data-testid="upi-save"
              disabled={save.isPending}
              onClick={() => run(false)}
            >
              {t('saveDraft')}
            </Button>
            <Button
              size="lg"
              data-testid="upi-complete"
              disabled={reasonMissing || save.isPending}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {t('completeUpi')}
            </Button>
          </div>
        )}
      </section>

      <ConfirmMoneyDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmUpiTitle', { date })}
        amountText={formatINR(statement)}
        words={amountWords(statement, locale)}
        confirmLabel={t('confirmUpi')}
        cancelLabel={t('back')}
        closeLabel={t('back')}
        onConfirm={() => run(true)}
        pending={save.isPending}
        error={error}
      >
        <p className="text-lg">
          {t('confirmUpiHelp', {
            system: formatINR(view.systemTotalPaise),
            difference: formatINR(difference < 0n ? -difference : difference),
          })}
        </p>
      </ConfirmMoneyDialog>
    </div>
  );
}
