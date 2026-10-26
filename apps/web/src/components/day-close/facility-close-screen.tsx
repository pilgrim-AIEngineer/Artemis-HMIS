'use client';

import { formatDateTime, formatINR, totalOfModes } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { ConfirmMoneyDialog } from '@hmis/ui/components/confirm-money-dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { PrintButton } from '@/components/print/print-button';
import { PrintOnMount } from '@/components/print/print-on-mount';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { amountWords, DifferenceText, ModeTiles } from './parts';

/**
 * Facility day close (admin / owner, BIL-06, docs/12 §6): every cashier's close of the day with
 * expected vs counted and the reasons, who still has an open counter, totals by mode, department
 * and doctor, and where the UPI reconciliation stands. Closing locks the day: later payments go
 * to the next business day. The A4 summary prints from here.
 */
export function FacilityCloseScreen({ initialDate }: { initialDate?: string }) {
  const t = useTranslations('dayClose');
  const locale = useLocale() === 'hi' ? 'hi' : 'en';
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [date, setDate] = useState(initialDate ?? '');
  const view = useQuery(trpc.dayClose.facility.queryOptions(date ? { date } : {}));
  const [confirming, setConfirming] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [closedId, setClosedId] = useState<string | null>(null);
  const key = useRef<{ sig: string; key: string } | null>(null);

  const close = useMutation(
    trpc.dayClose.closeFacility.mutationOptions({
      onSuccess: (r) => {
        setConfirming(false);
        setClosedId(r.dayCloseId);
        void qc.invalidateQueries({ queryKey: trpc.dayClose.facility.queryKey() });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );

  const v = view.data;
  if (view.isPending) return <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />;
  if (!v) return <FormStatus error={errorText(view.error)} />;

  const hasPending = v.pending.length > 0;
  const noteMissing = hasPending && acknowledge && note.trim().length < 3;
  const canClose = !v.close && (!hasPending || (acknowledge && !noteMissing));

  const submit = () => {
    if (close.isPending) return;
    const input = {
      closeDate: v.date,
      acknowledgePending: hasPending && acknowledge,
      note: hasPending && acknowledge ? note.trim() : undefined,
    };
    const sig = JSON.stringify(input);
    if (key.current?.sig !== sig) key.current = { sig, key: crypto.randomUUID() };
    setError(null);
    close.mutate({ ...input, idempotencyKey: key.current.key });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold">{t('facilityTitle')}</h1>
          <p className="text-lg text-muted-foreground">
            {v.lastClosedDate ? t('lastClosed', { date: v.lastClosedDate }) : t('neverClosed')}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="close-date">{t('businessDate')}</Label>
          <Input
            id="close-date"
            type="date"
            data-testid="close-date"
            className="w-48"
            value={v.date}
            onChange={(e) => {
              setClosedId(null);
              setAcknowledge(false);
              setDate(e.target.value);
            }}
          />
        </div>
      </div>

      {v.close && (
        <section
          className="space-y-3 rounded-lg border-2 border-money p-4"
          role="status"
          data-testid="facility-closed"
        >
          <p className="flex items-center gap-2 text-2xl font-semibold">
            <CheckCircle2 aria-hidden className="size-7 text-money" />
            {t('facilityClosed', {
              at: formatDateTime(v.close.closedAt),
              name: v.close.closedByName ?? '',
            })}
          </p>
          {v.close.note && <p className="text-lg">{v.close.note}</p>}
          {closedId && (
            <PrintOnMount key={closedId} template="facility-close" entityId={closedId} />
          )}
          <PrintButton
            template="facility-close"
            entityId={v.close.id}
            label={t('printSummary')}
            variant="outline"
            shortcut={false}
          />
        </section>
      )}

      {hasPending && !v.close && (
        <section
          className="space-y-3 rounded-lg border-2 border-destructive bg-card p-4"
          role="alert"
          data-testid="pending-counters"
        >
          <p className="flex items-center gap-2 text-xl font-semibold text-destructive">
            <TriangleAlert aria-hidden className="size-6" />
            {t('pendingTitle')}
          </p>
          <ul className="divide-y">
            {v.pending.map((p) => (
              <li key={p.userId} className="flex justify-between gap-4 py-2 text-lg">
                <span className="font-semibold">{p.userName}</span>
                <span className="tabular-nums">
                  {t('pendingLine', { count: p.paymentCount, cash: formatINR(p.cashPaise) })}
                </span>
              </li>
            ))}
          </ul>
          <p>{t('pendingHelp')}</p>
        </section>
      )}

      <ModeTiles totals={v.totals} />

      <section aria-labelledby="users-h" className="space-y-2">
        <h2 id="users-h" className="text-xl font-semibold">
          {t('counters')}
        </h2>
        {v.userCloses.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-lg">{t('noCounters')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full" data-testid="user-closes">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="px-4 py-2">{t('counter')}</th>
                  <th className="px-4 py-2">{t('closedAt')}</th>
                  <th className="px-4 py-2 text-right">{t('expectedCash')}</th>
                  <th className="px-4 py-2 text-right">{t('countedCash')}</th>
                  <th className="px-4 py-2 text-right">{t('difference')}</th>
                  <th className="px-4 py-2">{t('reason')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {v.userCloses.map((c) => (
                  <tr key={c.id} className="border-b last:border-0" data-testid="user-close-row">
                    <th scope="row" className="px-4 py-2 text-left font-semibold">
                      {c.userName}
                    </th>
                    <td className="px-4 py-2">{formatDateTime(c.closedAt)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatINR(c.totals.cashPaise)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatINR(c.cashCountedPaise)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <DifferenceText paise={c.differencePaise} />
                    </td>
                    <td className="px-4 py-2">{c.differenceReason}</td>
                    <td className="px-4 py-2 text-right">
                      <PrintButton
                        template="day-close"
                        entityId={c.id}
                        label={t('printSlip')}
                        variant="outline"
                        shortcut={false}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="px-4 py-2" colSpan={2}>
                    {t('total')}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatINR(v.totals.cashPaise)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatINR(v.cashCountedPaise)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DifferenceText paise={v.differencePaise} testId="facility-difference" />
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Breakdown title={t('byDepartment')} rows={v.byDepartment} />
        <Breakdown title={t('byDoctor')} rows={v.byDoctor} />
      </div>

      <section
        aria-labelledby="upi-h"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
      >
        <div>
          <h2 id="upi-h" className="text-xl font-semibold">
            {t('upiStatus')}
          </h2>
          <p className="text-lg" data-testid="upi-status">
            {t(`upiState.${v.upiStatus}`)}
            {v.upiDifferencePaise !== null && v.upiDifferencePaise !== 0n && (
              <>
                {' · '}
                <DifferenceText paise={v.upiDifferencePaise} />
              </>
            )}
          </p>
        </div>
        <Button asChild variant="outline" size="lg">
          <Link href={`/billing/upi-reconciliation?date=${v.date}`}>{t('openUpi')}</Link>
        </Button>
      </section>

      {!v.close && (
        <section className="max-w-xl space-y-3">
          {hasPending && (
            <div className="space-y-2">
              <label className="flex items-start gap-3 text-lg">
                <input
                  type="checkbox"
                  className="mt-1 size-6"
                  data-testid="acknowledge-pending"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                />
                <span>{t('acknowledge')}</span>
              </label>
              {acknowledge && (
                <div className="space-y-2">
                  <Label htmlFor="pending-note">{t('noteLabel')}</Label>
                  <Input
                    id="pending-note"
                    data-testid="pending-note"
                    maxLength={200}
                    value={note}
                    aria-invalid={noteMissing || undefined}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
          <FormStatus error={confirming ? null : error} />
          <Button
            size="lg"
            data-testid="facility-close-submit"
            disabled={!canClose || close.isPending}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {t('closeDay')}
          </Button>
        </section>
      )}

      <ConfirmMoneyDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmFacilityTitle', { date: v.date })}
        amountText={formatINR(totalOfModes(v.totals))}
        words={amountWords(totalOfModes(v.totals), locale)}
        confirmLabel={t('confirmCloseDay')}
        cancelLabel={t('back')}
        closeLabel={t('back')}
        onConfirm={submit}
        pending={close.isPending}
        error={error}
      >
        <p className="text-lg">{t('confirmFacilityHelp')}</p>
      </ConfirmMoneyDialog>
    </div>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; netPaise: bigint }[];
}) {
  const t = useTranslations('dayClose');
  return (
    <section className="space-y-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      <ul className="divide-y rounded-lg border bg-card">
        {rows.length === 0 && <li className="px-4 py-3 text-muted-foreground">{t('nothing')}</li>}
        {rows.map((r) => (
          <li key={r.key} className="flex justify-between gap-4 px-4 py-2 text-lg">
            <span>{r.label || t('unattributed')}</span>
            <span className="font-semibold tabular-nums">{formatINR(r.netPaise)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
