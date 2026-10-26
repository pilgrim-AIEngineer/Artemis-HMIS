'use client';

import { formatDate } from '@hmis/shared';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { ReportShell } from './report-shell';
import { csvSection, ReportTable, Tile, type Col } from './report-table';

type Row = inferRouterOutputs<AppRouter>['reports']['vaccinesDue']['overdue'][number];

/**
 * Vaccines due this week and overdue (RPT-01, docs/20 §2). The overdue list carries the phone
 * number: it is the list the front desk calls from.
 */
export function VaccinesReport() {
  const t = useTranslations('reports');
  const tAge = useTranslations('age');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const q = useQuery(trpc.reports.vaccinesDue.queryOptions({ aheadDays: 7 }));
  const r = q.data;

  const age = (x: Row) => tAge(x.age.unit, { count: x.age.value });
  const due = (x: Row) => formatDate(x.nextDueDate);
  const cols = (late: boolean): Col<Row>[] => [
    { key: 'uhid', header: t('vaccines.uhid'), cell: (x) => x.uhid, csv: (x) => x.uhid },
    { key: 'name', header: t('vaccines.child'), cell: (x) => x.name, csv: (x) => x.name },
    { key: 'age', header: t('vaccines.age'), cell: age, csv: age },
    {
      key: 'mobile',
      header: t('vaccines.mobile'),
      cell: (x) => x.mobile ?? t('vaccines.noMobile'),
      csv: (x) => x.mobile,
    },
    { key: 'due', header: t('vaccines.dueOn'), cell: due, csv: due },
    late
      ? {
          key: 'late',
          header: t('vaccines.daysLate'),
          cell: (x) => -x.daysFromToday,
          csv: (x) => -x.daysFromToday,
          right: true,
        }
      : {
          key: 'in',
          header: t('vaccines.inDays'),
          cell: (x) => x.daysFromToday,
          csv: (x) => x.daysFromToday,
          right: true,
        },
  ];

  return (
    <ReportShell
      title={t('tiles.vaccines.title')}
      fileName="vaccines-due"
      range={null}
      asOf={r?.today}
      csv={
        r
          ? () => [
              ...csvSection(t('vaccines.overdue'), cols(true), r.overdue),
              ...csvSection(t('vaccines.thisWeek'), cols(false), r.thisWeek),
            ]
          : null
      }
    >
      {q.isPending && <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />}
      {q.isError && <FormStatus error={errorText(q.error)} />}
      {r && (
        <>
          <section aria-label={t('vaccines.totals')} className="grid gap-3 sm:grid-cols-2">
            <Tile
              label={t('vaccines.overdue')}
              value={r.overdue.length}
              testId="tile-overdue"
              tone={r.overdue.length ? 'alert' : undefined}
              strong
            />
            <Tile label={t('vaccines.thisWeek')} value={r.thisWeek.length} testId="tile-week" />
          </section>
          <ReportTable
            id="vaccines-overdue"
            caption={t('vaccines.overdue')}
            columns={cols(true)}
            rows={r.overdue}
            rowKey={(x) => x.patientId}
            empty={t('vaccines.noneOverdue')}
          />
          <ReportTable
            id="vaccines-week"
            caption={t('vaccines.thisWeek')}
            columns={cols(false)}
            rows={r.thisWeek}
            rowKey={(x) => x.patientId}
            empty={t('vaccines.noneWeek')}
          />
        </>
      )}
    </ReportShell>
  );
}
