'use client';

import { csvRupees, formatDateTime, formatINR, reportRangeSchema } from '@hmis/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { csvSection, ReportTable, Tile, type Col, type Footer } from './report-table';
import { ReportShell, useDateRange } from './report-shell';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/trpc/root';

type Report = inferRouterOutputs<AppRouter>['reports']['collection'];
type Row = Report['total'];
type Receipt = Report['receipts'][number];

/**
 * Daily collection (RPT-01, docs/20 §2): money by mode for each user, day, doctor and department,
 * refunds and the net, and every receipt. Counted by business day like the day close, so a day
 * here equals the facility close of that day.
 */
export function CollectionReport() {
  const t = useTranslations('reports');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [range, setRange] = useDateRange();
  const valid = reportRangeSchema.safeParse(range).success;
  const q = useQuery({ ...trpc.reports.collection.queryOptions(range), enabled: valid });
  const r = q.data;

  const money = (p: bigint) => formatINR(p);
  const cols = (label: string): Col<Row>[] => [
    {
      key: 'label',
      header: label,
      cell: (x) => x.label || t('collection.unlinked'),
      csv: (x) => x.label || t('collection.unlinked'),
    },
    {
      key: 'cash',
      header: t('mode.cash'),
      cell: (x) => money(x.cashPaise),
      csv: (x) => csvRupees(x.cashPaise),
      right: true,
    },
    {
      key: 'upi',
      header: t('mode.upi'),
      cell: (x) => money(x.upiPaise),
      csv: (x) => csvRupees(x.upiPaise),
      right: true,
    },
    {
      key: 'card',
      header: t('mode.card'),
      cell: (x) => money(x.cardPaise),
      csv: (x) => csvRupees(x.cardPaise),
      right: true,
    },
    {
      key: 'other',
      header: t('mode.other'),
      cell: (x) => money(x.otherPaise),
      csv: (x) => csvRupees(x.otherPaise),
      right: true,
    },
    {
      key: 'refunds',
      header: t('collection.refunds'),
      cell: (x) => money(x.refundedPaise),
      csv: (x) => csvRupees(x.refundedPaise),
      right: true,
    },
    {
      key: 'net',
      header: t('collection.net'),
      cell: (x) => money(x.netPaise),
      csv: (x) => csvRupees(x.netPaise),
      right: true,
    },
    {
      key: 'count',
      header: t('collection.receipts'),
      cell: (x) => x.count,
      csv: (x) => x.count,
      right: true,
    },
  ];
  const footer = (x: Row): Footer<Row> => ({
    label: t('total'),
    cells: {
      cash: { cell: money(x.cashPaise), csv: csvRupees(x.cashPaise) },
      upi: { cell: money(x.upiPaise), csv: csvRupees(x.upiPaise) },
      card: { cell: money(x.cardPaise), csv: csvRupees(x.cardPaise) },
      other: { cell: money(x.otherPaise), csv: csvRupees(x.otherPaise) },
      refunds: { cell: money(x.refundedPaise), csv: csvRupees(x.refundedPaise) },
      net: { cell: money(x.netPaise), csv: csvRupees(x.netPaise) },
      count: { cell: x.count, csv: x.count },
    },
  });
  const receiptCols: Col<Receipt>[] = [
    { key: 'no', header: t('collection.receiptNo'), cell: (x) => x.number, csv: (x) => x.number },
    {
      key: 'at',
      header: t('collection.at'),
      cell: (x) => formatDateTime(x.at),
      csv: (x) => formatDateTime(x.at),
    },
    { key: 'uhid', header: t('collection.uhid'), cell: (x) => x.uhid, csv: (x) => x.uhid },
    {
      key: 'patient',
      header: t('collection.patient'),
      cell: (x) => x.patientName,
      csv: (x) => x.patientName,
    },
    {
      key: 'bill',
      header: t('collection.bill'),
      cell: (x) => x.billNumber ?? '',
      csv: (x) => x.billNumber,
    },
    {
      key: 'mode',
      header: t('collection.mode'),
      cell: (x) => t(`mode.${modeKey(x.mode)}`),
      csv: (x) => t(`mode.${modeKey(x.mode)}`),
    },
    {
      key: 'kind',
      header: t('collection.kind'),
      cell: (x) => t(`kind.${kindKey(x.kind)}`),
      csv: (x) => t(`kind.${kindKey(x.kind)}`),
    },
    {
      key: 'amount',
      header: t('collection.amount'),
      cell: (x) => money(x.amountPaise),
      csv: (x) => csvRupees(x.amountPaise),
      right: true,
    },
    {
      key: 'by',
      header: t('collection.receivedBy'),
      cell: (x) => x.receivedByName ?? '',
      csv: (x) => x.receivedByName,
    },
  ];

  const sections = r
    ? ([
        ['byDay', t('collection.byDay'), r.byDay],
        ['byUser', t('collection.byUser'), r.byUser],
        ['byDoctor', t('collection.byDoctor'), r.byDoctor],
        ['byDepartment', t('collection.byDepartment'), r.byDepartment],
      ] as const)
    : [];
  const headers = {
    byDay: t('collection.day'),
    byUser: t('collection.user'),
    byDoctor: t('collection.doctor'),
    byDepartment: t('collection.department'),
  };

  return (
    <ReportShell
      title={t('tiles.collection.title')}
      fileName="daily-collection"
      range={range}
      onRange={setRange}
      csv={
        r
          ? () => [
              ...sections.flatMap(([k, title, rows]) =>
                csvSection(title, cols(headers[k]), [...rows], footer(r.total)),
              ),
              ...csvSection(t('collection.receiptList'), receiptCols, r.receipts),
            ]
          : null
      }
    >
      {!valid && (
        <FormStatus
          error={errorText(reportRangeSchema.safeParse(range).error?.issues[0]?.message)}
        />
      )}
      {q.isPending && valid && <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />}
      {q.isError && <FormStatus error={errorText(q.error)} />}
      {r && (
        <>
          <section
            aria-label={t('collection.totals')}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Tile label={t('mode.cash')} value={money(r.total.cashPaise)} testId="tile-cash" />
            <Tile label={t('mode.upi')} value={money(r.total.upiPaise)} testId="tile-upi" />
            <Tile label={t('mode.card')} value={money(r.total.cardPaise)} testId="tile-card" />
            <Tile
              label={t('collection.netCollection')}
              value={money(r.total.netPaise)}
              testId="tile-net"
              strong
            />
          </section>
          <p className="text-muted-foreground">
            {t('collection.refundNote', {
              refunded: money(r.total.refundedPaise),
              collected: money(r.total.collectedPaise),
            })}
          </p>
          {r.reversed.count > 0 && (
            <p
              role="status"
              className="rounded-lg border-2 border-amber-600 bg-card p-3"
              data-testid="reversed-note"
            >
              {t('collection.reversedNote', {
                count: r.reversed.count,
                amount: money(r.reversed.paise),
              })}
            </p>
          )}
          {sections.map(([k, title, rows]) => (
            <ReportTable
              key={k}
              id={`collection-${k}`}
              caption={title}
              columns={cols(headers[k])}
              rows={[...rows]}
              footer={footer(r.total)}
              rowKey={(x) => x.key}
              empty={t('empty')}
            />
          ))}
          <ReportTable
            id="collection-receipts"
            caption={t('collection.receiptList')}
            columns={receiptCols}
            rows={r.receipts}
            rowKey={(x) => x.id}
            empty={t('empty')}
          />
          {r.truncated && (
            <p role="status" className="rounded-lg border-2 border-amber-600 bg-card p-3">
              {t('collection.truncated', { count: r.receipts.length })}
            </p>
          )}
        </>
      )}
    </ReportShell>
  );
}

const modeKey = (m: string) => (m === 'cash' || m === 'upi' || m === 'card' ? m : 'other');
const kindKey = (k: string) => (k === 'refund' || k === 'deposit' ? k : 'payment');
