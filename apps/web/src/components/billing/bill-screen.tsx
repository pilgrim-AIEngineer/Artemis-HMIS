'use client';

import { bpToPercent, formatDateTime, formatINR, maskRef, type Permission } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { PatientHeader } from '@hmis/ui/components/patient-header';
import { cn } from '@hmis/ui/lib/utils';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, IndianRupee, Plus, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, type KeyboardEvent } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { PrintButton } from '@/components/print/print-button';
import { PrintOnMount } from '@/components/print/print-on-mount';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useAgeText } from '@/lib/use-age-text';
import { useDebounced } from '@/lib/use-debounced';
import { useErrorText } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';
import { PaymentDialog, type PaidResult } from './payment-dialog';

/** Bill status chip: text and colour, never colour alone (docs/05 §4). */
export function BillStatusChip({ status }: { status: string }) {
  const t = useTranslations('billing.status');
  return (
    <span
      className={cn(
        'rounded-full border-2 px-3 py-0.5 text-sm font-semibold',
        status === 'final' && 'border-money text-money',
        status === 'draft' && 'border-primary text-primary',
        status === 'cancelled' && 'border-destructive text-destructive',
      )}
    >
      {t(status as 'draft' | 'final' | 'cancelled')}
    </span>
  );
}

/**
 * One OPD bill (BIL-01, docs/12 §2): lines priced from the visit's tariff, "Add service" search
 * (↑/↓, Enter), remove a draft line, totals with GST and round-off, payments with their receipts,
 * and "Collect payment" (F8). The payment that clears the bill finalises it, prints the receipt
 * and releases the token; a final bill is read-only (corrections are credit notes, BIL-04).
 */
export function BillScreen({ billId }: { billId: string }) {
  const t = useTranslations('billing');
  const tR = useTranslations('reception');
  const locale = useLocale();
  const ageText = useAgeText();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { me } = useSession();
  const can = (p: Permission) => me.permissions.includes(p);

  const bill = useQuery(trpc.billing.get.queryOptions({ billId }));
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState<PaidResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.billing.pathKey() });
  const remove = useMutation(
    trpc.billing.removeLine.mutationOptions({
      onSuccess: () => {
        setError(null);
        void refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const finalize = useMutation(
    trpc.billing.finalize.mutationOptions({
      onSuccess: () => {
        setError(null);
        void refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );

  const b = bill.data;
  const canPay =
    !!b && b.status !== 'cancelled' && b.balancePaise > 0n && can('billing.payment.collect');
  useShortcut('F8', () => setPaying(true), canPay && !paying);

  if (bill.isPending) {
    return <div className="h-40 animate-pulse rounded-lg bg-muted" aria-busy="true" />;
  }
  if (!b) {
    return (
      <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
        {bill.error ? errorText(bill.error) : t('notFound')}
      </p>
    );
  }
  const draft = b.status === 'draft';
  const name = (l: { description: string; descriptionHi: string | null }) =>
    locale === 'hi' && l.descriptionHi ? l.descriptionHi : l.description;
  const collections = [...new Map(b.payments.map((p) => [p.collectionId, p])).values()];

  return (
    <div className="space-y-5">
      <PatientHeader
        name={b.patient.fullName}
        nameHi={b.patient.nameHi}
        ageSex={`${ageText(b.patient.dob)} / ${tR(`sex.${b.patient.sex as 'F' | 'M' | 'O'}`)}`}
        uhid={b.patient.uhid}
        mobileLast4={b.patient.mobile?.slice(-4)}
        mobileLabel={tR('columns.mobile')}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex flex-wrap items-center gap-3 text-3xl font-semibold">
            {b.number ? t('billNo', { number: b.number }) : t('draftTitle')}
            <BillStatusChip status={b.status} />
          </h1>
          <p className="text-muted-foreground">
            {t('visitLine', {
              number: b.encounterNumber,
              doctor: locale === 'hi' && b.doctorNameHi ? b.doctorNameHi : b.doctorName,
            })}
            {b.tokenNo !== null && ` · ${t('tokenNo', { token: b.tokenNo })}`}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/billing">{t('backToDesk')}</Link>
        </Button>
      </div>

      {paid && (
        <section
          className="space-y-3 rounded-lg border-2 border-money p-4"
          role="status"
          data-testid="payment-done"
        >
          <p className="flex items-center gap-2 text-2xl font-semibold">
            <CheckCircle2 aria-hidden className="size-7 text-money" />
            {t('paidDone', {
              amount: formatINR(BigInt(paid.totalPaise)),
              receipt: paid.receiptNumber,
            })}
          </p>
          {paid.tokenNo !== null && (
            <p className="text-5xl font-bold tabular-nums">
              <span className="text-2xl font-semibold text-muted-foreground">{t('token')} </span>
              {paid.tokenNo}
            </p>
          )}
          <PrintOnMount key={paid.collectionId} template="receipt" entityId={paid.collectionId} />
        </section>
      )}

      <section aria-labelledby="bill-lines" className="space-y-3">
        <h2 id="bill-lines" className="text-xl font-semibold">
          {t('lines')}
        </h2>
        {b.lines.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-lg">{t('noLines')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-base">
              <thead className="sticky top-0 bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">{t('cols.item')}</th>
                  <th className="px-3 py-2 text-right">{t('cols.qty')}</th>
                  <th className="px-3 py-2 text-right">{t('cols.rate')}</th>
                  <th className="px-3 py-2 text-right">{t('cols.gst')}</th>
                  <th className="px-3 py-2 text-right">{t('cols.amount')}</th>
                  {draft && (
                    <th className="px-3 py-2">
                      <span className="sr-only">{t('cols.actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-muted/40">
                {b.lines.map((l) => (
                  <tr key={l.id} data-testid="bill-line">
                    <td className="px-3 py-2">{name(l)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.qty.replace(/\.?0+$/, '')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatINR(l.unitRatePaise)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.gstRateBp === 0 ? t('exempt') : `${bpToPercent(l.gstRateBp)}%`}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {formatINR(l.patientSharePaise)}
                    </td>
                    {draft && (
                      <td className="px-3 py-1 text-right">
                        {can('billing.bill.create') && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('removeLine', { item: name(l) })}
                            disabled={remove.isPending}
                            onClick={() =>
                              remove.mutate({
                                billId,
                                lineId: l.id,
                                idempotencyKey: crypto.randomUUID(),
                              })
                            }
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft && can('billing.bill.create') && (
          <AddService billId={billId} onAdded={() => void refresh()} onError={setError} />
        )}
      </section>

      <section
        aria-labelledby="bill-totals"
        className="ml-auto max-w-md space-y-1 rounded-lg border-2 bg-card p-4 text-lg tabular-nums"
      >
        <h2 id="bill-totals" className="sr-only">
          {t('totals')}
        </h2>
        <Row label={t('gross')} value={formatINR(b.grossPaise)} />
        {b.discountPaise > 0n && (
          <Row label={t('discount')} value={`-${formatINR(b.discountPaise)}`} />
        )}
        {b.cgstPaise + b.sgstPaise > 0n && (
          <>
            <Row label={t('cgst')} value={formatINR(b.cgstPaise)} />
            <Row label={t('sgst')} value={formatINR(b.sgstPaise)} />
          </>
        )}
        {b.roundOffPaise !== 0n && <Row label={t('roundOff')} value={formatINR(b.roundOffPaise)} />}
        <Row label={t('net')} value={formatINR(b.netPaise)} strong testId="bill-net" />
        <Row label={t('paid')} value={formatINR(b.paidPaise)} />
        <div className="flex items-baseline justify-between border-t-2 pt-2">
          <span className="font-semibold">{t('balance')}</span>
          <span className="text-3xl font-bold" data-testid="bill-balance">
            {formatINR(b.balancePaise)}
          </span>
        </div>
      </section>

      {error && (
        <p role="alert" className="font-medium text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        {draft && b.balancePaise === 0n && b.lines.length > 0 && can('billing.bill.finalize') && (
          <Button
            size="lg"
            disabled={finalize.isPending}
            onClick={() => finalize.mutate({ billId, idempotencyKey: crypto.randomUUID() })}
          >
            {t('finalize')}
          </Button>
        )}
        {canPay && (
          <Button variant="money" size="lg" onClick={() => setPaying(true)} data-testid="collect">
            <IndianRupee aria-hidden />
            {t('collect', { amount: formatINR(b.balancePaise) })}
            <ShortcutHint keys="F8" />
          </Button>
        )}
      </div>

      {collections.length > 0 && (
        <section aria-labelledby="bill-payments" className="space-y-2">
          <h2 id="bill-payments" className="text-xl font-semibold">
            {t('payments')}
          </h2>
          <ul className="divide-y rounded-lg border bg-card">
            {collections.map((c) => {
              const rows = b.payments.filter((p) => p.collectionId === c.collectionId);
              return (
                <li
                  key={c.collectionId}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div>
                    <p className="font-semibold">
                      {c.number} · {formatDateTime(c.receivedAt)}
                    </p>
                    <p className="text-muted-foreground">
                      {rows
                        .map(
                          (p) =>
                            `${t(`modes.${p.mode as 'cash' | 'upi' | 'card'}`)} ${formatINR(p.amountPaise)}${
                              p.upiRef ? ` (UTR ${maskRef(p.upiRef)})` : ''
                            }${p.cardLast4 ? ` (…${p.cardLast4})` : ''}`,
                        )
                        .join(' + ')}
                      {c.receivedByName && ` · ${c.receivedByName}`}
                    </p>
                  </div>
                  {can('billing.payment.collect') && (
                    <PrintButton
                      template="receipt"
                      entityId={c.collectionId}
                      label={t('printReceipt')}
                      variant="outline"
                      shortcut={false}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {canPay && (
        <PaymentDialog
          billId={billId}
          balancePaise={b.balancePaise}
          open={paying}
          onOpenChange={setPaying}
          onPaid={(r) => {
            setPaid(r);
            void refresh();
            void queryClient.invalidateQueries({ queryKey: [['queue']] });
          }}
        />
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'font-semibold')}>
      <span>{label}</span>
      <span data-testid={testId}>{value}</span>
    </div>
  );
}

/** Service search for a draft: type, ↑/↓, Enter adds; services without a rate cannot be picked. */
function AddService({
  billId,
  onAdded,
  onError,
}: {
  billId: string;
  onAdded: () => void;
  onError: (e: string | null) => void;
}) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 150);
  const listId = useId();
  const list = useQuery(
    trpc.billing.services.queryOptions(
      { billId, q: debounced },
      { enabled: debounced.length > 0, placeholderData: keepPreviousData },
    ),
  );
  const rows = debounced ? (list.data ?? []) : [];
  const add = useMutation(
    trpc.billing.addLine.mutationOptions({
      onSuccess: () => {
        onError(null);
        setQ('');
        onAdded();
      },
      onError: (e) => onError(errorText(e)),
    }),
  );
  const pick = (i: number) => {
    const s = rows[i];
    if (!s || s.ratePaise === null || add.isPending) return;
    add.mutate({ billId, serviceId: s.id, idempotencyKey: crypto.randomUUID() });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  };
  return (
    <div className="max-w-2xl space-y-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          role="combobox"
          autoComplete="off"
          aria-label={t('addService')}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={rows[active] ? `${listId}-${rows[active].id}` : undefined}
          placeholder={t('addServicePlaceholder')}
          className="pl-10"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {rows.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('addService')}
          className="divide-y rounded-lg border bg-card"
        >
          {rows.map((s, i) => (
            <li
              key={s.id}
              id={`${listId}-${s.id}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={s.ratePaise === null}
              onClick={() => pick(i)}
              onMouseMove={() => i !== active && setActive(i)}
              className={cn(
                'flex min-h-12 cursor-pointer items-center justify-between gap-3 px-3 py-2',
                i === active && 'bg-accent outline-2 -outline-offset-2 outline-ring',
                s.ratePaise === null && 'cursor-not-allowed text-muted-foreground',
              )}
            >
              <span>
                <Plus aria-hidden className="mr-2 inline size-4" />
                {locale === 'hi' && s.nameHi ? s.nameHi : s.name}
                <span className="ml-2 text-sm text-muted-foreground">{s.code}</span>
              </span>
              <span className="tabular-nums">
                {s.ratePaise === null ? t('noRate') : formatINR(s.ratePaise)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {debounced && list.isSuccess && rows.length === 0 && (
        <p className="text-muted-foreground">{t('noServices')}</p>
      )}
    </div>
  );
}
