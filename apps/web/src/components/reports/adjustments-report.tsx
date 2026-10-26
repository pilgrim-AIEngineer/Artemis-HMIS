'use client';

import { csvRupees, formatDateTime, formatINR, reportRangeSchema } from '@hmis/shared';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { ReportShell, useDateRange } from './report-shell';
import { csvSection, ReportTable, Tile, type Col } from './report-table';

type Out = inferRouterOutputs<AppRouter>['billing'];
type Discount = Out['discountReport']['rows'][number];
type Cancellation = Out['cancellationReport']['rows'][number];

/**
 * Discounts and cancellations (RPT-01, docs/12 §4–5, docs/20 §2) for the owner: who gave how much
 * and why, who approved, and every credit note with the refund paid out with it. Discounts that
 * were replaced or cleared stay listed (status) but are not in the total.
 */
export function AdjustmentsReport() {
  const t = useTranslations('reports');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [range, setRange] = useDateRange();
  const check = reportRangeSchema.safeParse(range);
  const discounts = useQuery({
    ...trpc.billing.discountReport.queryOptions(range),
    enabled: check.success,
  });
  const cancels = useQuery({
    ...trpc.billing.cancellationReport.queryOptions(range),
    enabled: check.success,
  });
  const d = discounts.data;
  const c = cancels.data;

  const money = (p: bigint) => formatINR(p);
  const approver = (x: { approvedByName: string | null; approvalMethod: string | null }) =>
    x.approvedByName
      ? `${x.approvedByName} (${t(`method.${x.approvalMethod === 'pin' ? 'pin' : 'self'}`)})`
      : '';
  const reason = (x: { reasonLabel: string; reasonText: string | null }) =>
    x.reasonText ? `${x.reasonLabel}: ${x.reasonText}` : x.reasonLabel;

  const dCols: Col<Discount>[] = [
    {
      key: 'at',
      header: t('adjustments.at'),
      cell: (x) => formatDateTime(x.at),
      csv: (x) => formatDateTime(x.at),
    },
    {
      key: 'bill',
      header: t('adjustments.bill'),
      cell: (x) => x.billNumber ?? t('adjustments.draft'),
      csv: (x) => x.billNumber ?? t('adjustments.draft'),
    },
    { key: 'uhid', header: t('adjustments.uhid'), cell: (x) => x.uhid, csv: (x) => x.uhid },
    {
      key: 'scope',
      header: t('adjustments.scope'),
      cell: (x) =>
        x.scope === 'line'
          ? (x.lineDescription ?? t('adjustments.line'))
          : t('adjustments.wholeBill'),
      csv: (x) =>
        x.scope === 'line'
          ? (x.lineDescription ?? t('adjustments.line'))
          : t('adjustments.wholeBill'),
    },
    {
      key: 'amount',
      header: t('adjustments.amount'),
      cell: (x) => money(x.amountPaise),
      csv: (x) => csvRupees(x.amountPaise),
      right: true,
    },
    { key: 'reason', header: t('adjustments.reason'), cell: reason, csv: reason },
    {
      key: 'by',
      header: t('adjustments.givenBy'),
      cell: (x) => x.givenByName ?? '',
      csv: (x) => x.givenByName,
    },
    { key: 'approver', header: t('adjustments.approvedBy'), cell: approver, csv: approver },
    {
      key: 'status',
      header: t('adjustments.status'),
      cell: (x) => t(`status.${x.status === 'active' ? 'active' : 'cancelled'}`),
      csv: (x) => t(`status.${x.status === 'active' ? 'active' : 'cancelled'}`),
    },
  ];
  const cCols: Col<Cancellation>[] = [
    { key: 'no', header: t('adjustments.creditNote'), cell: (x) => x.number, csv: (x) => x.number },
    {
      key: 'at',
      header: t('adjustments.at'),
      cell: (x) => formatDateTime(x.at),
      csv: (x) => formatDateTime(x.at),
    },
    {
      key: 'bill',
      header: t('adjustments.bill'),
      cell: (x) => x.billNumber ?? '',
      csv: (x) => x.billNumber,
    },
    { key: 'uhid', header: t('adjustments.uhid'), cell: (x) => x.uhid, csv: (x) => x.uhid },
    {
      key: 'patient',
      header: t('adjustments.patient'),
      cell: (x) => x.patientName,
      csv: (x) => x.patientName,
    },
    {
      key: 'amount',
      header: t('adjustments.credited'),
      cell: (x) => money(x.amountPaise),
      csv: (x) => csvRupees(x.amountPaise),
      right: true,
    },
    {
      key: 'refund',
      header: t('adjustments.refunded'),
      cell: (x) => money(x.refundPaise),
      csv: (x) => csvRupees(x.refundPaise),
      right: true,
    },
    {
      key: 'full',
      header: t('adjustments.kind'),
      cell: (x) => t(x.cancelsBill ? 'adjustments.fullCancel' : 'adjustments.partial'),
      csv: (x) => t(x.cancelsBill ? 'adjustments.fullCancel' : 'adjustments.partial'),
    },
    { key: 'reason', header: t('adjustments.reason'), cell: reason, csv: reason },
    {
      key: 'by',
      header: t('adjustments.issuedBy'),
      cell: (x) => x.issuedByName ?? '',
      csv: (x) => x.issuedByName,
    },
    { key: 'approver', header: t('adjustments.approvedBy'), cell: approver, csv: approver },
  ];
  const dFoot = d && {
    label: t('total'),
    cells: { amount: { cell: money(d.totalPaise), csv: csvRupees(d.totalPaise) } },
  };
  const cFoot = c && {
    label: t('total'),
    cells: {
      amount: { cell: money(c.totalCreditedPaise), csv: csvRupees(c.totalCreditedPaise) },
      refund: { cell: money(c.totalRefundedPaise), csv: csvRupees(c.totalRefundedPaise) },
    },
  };

  return (
    <ReportShell
      title={t('tiles.adjustments.title')}
      fileName="discounts-cancellations"
      range={range}
      onRange={setRange}
      csv={
        d && c
          ? () => [
              ...csvSection(t('adjustments.discounts'), dCols, d.rows, dFoot),
              ...csvSection(t('adjustments.cancellations'), cCols, c.rows, cFoot),
            ]
          : null
      }
    >
      {!check.success && <FormStatus error={errorText(check.error.issues[0]?.message)} />}
      {(discounts.isPending || cancels.isPending) && check.success && (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />
      )}
      {discounts.isError && <FormStatus error={errorText(discounts.error)} />}
      {cancels.isError && <FormStatus error={errorText(cancels.error)} />}
      {d && c && dFoot && cFoot && (
        <>
          <section aria-label={t('adjustments.totals')} className="grid gap-3 sm:grid-cols-3">
            <Tile
              label={t('adjustments.discountTotal')}
              value={money(d.totalPaise)}
              testId="tile-discounts"
              strong
            />
            <Tile
              label={t('adjustments.creditedTotal')}
              value={money(c.totalCreditedPaise)}
              testId="tile-credited"
            />
            <Tile
              label={t('adjustments.refundedTotal')}
              value={money(c.totalRefundedPaise)}
              testId="tile-refunded"
            />
          </section>
          <ReportTable
            id="discounts"
            caption={t('adjustments.discounts')}
            columns={dCols}
            rows={d.rows}
            footer={dFoot}
            rowKey={(x) => x.id}
            empty={t('adjustments.noDiscounts')}
          />
          <ReportTable
            id="cancellations"
            caption={t('adjustments.cancellations')}
            columns={cCols}
            rows={c.rows}
            footer={cFoot}
            rowKey={(x) => x.id}
            empty={t('adjustments.noCancellations')}
          />
        </>
      )}
    </ReportShell>
  );
}
