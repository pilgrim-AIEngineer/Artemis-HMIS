'use client';

import { opdCensusInputSchema, VISIT_TYPES, type VisitType } from '@hmis/shared';
import { cn } from '@hmis/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { ReportShell, useDateRange } from './report-shell';
import { csvSection, ReportTable, Tile, type Col } from './report-table';

type Census = inferRouterOutputs<AppRouter>['reports']['opdCensus'];
type Row = Census['rows'][number];

/**
 * OPD counts (RPT-01, docs/20 §2): visits by doctor and visit type, the arrival hours as a
 * heat table and the average wait from token to the doctor. Cancelled visits are counted apart.
 */
export function OpdReport() {
  const t = useTranslations('reports');
  const tType = useTranslations('queue.visitTypes');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [range, setRange] = useDateRange();
  const check = opdCensusInputSchema.safeParse(range);
  const q = useQuery({ ...trpc.reports.opdCensus.queryOptions(range), enabled: check.success });
  const r = q.data;

  const wait = (m: number | null) => (m === null ? '—' : t('opd.minutes', { count: m }));
  const cols: Col<Row>[] = [
    { key: 'doctor', header: t('opd.doctor'), cell: (x) => x.doctor, csv: (x) => x.doctor },
    ...VISIT_TYPES.map((v): Col<Row> => ({
      key: v,
      header: tType(v),
      cell: (x) => x.byType[v],
      csv: (x) => x.byType[v],
      right: true,
    })),
    { key: 'total', header: t('total'), cell: (x) => x.total, csv: (x) => x.total, right: true },
    {
      key: 'wait',
      header: t('opd.avgWait'),
      cell: (x) => wait(x.avgWaitMinutes),
      csv: (x) => x.avgWaitMinutes,
      right: true,
    },
  ];
  const footer = r && {
    label: t('total'),
    cells: {
      ...Object.fromEntries(
        VISIT_TYPES.map((v: VisitType) => [v, { cell: r.totalsByType[v], csv: r.totalsByType[v] }]),
      ),
      total: { cell: r.total, csv: r.total },
      wait: { cell: wait(r.avgWaitMinutes), csv: r.avgWaitMinutes },
    },
  };

  const used = r?.byHour.filter((h) => h.count > 0) ?? [];
  const from = used[0]?.hour ?? 9;
  const to = used.at(-1)?.hour ?? 14;
  const hours = r?.byHour.filter((h) => h.hour >= from && h.hour <= to) ?? [];
  const peak = Math.max(1, ...hours.map((h) => h.count));
  const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

  return (
    <ReportShell
      title={t('tiles.opd.title')}
      fileName="opd-census"
      range={range}
      onRange={setRange}
      csv={
        r && footer
          ? () => [
              ...csvSection(t('tiles.opd.title'), cols, r.rows, footer),
              ...csvSection(
                t('opd.byHour'),
                [
                  {
                    key: 'h',
                    header: t('opd.hour'),
                    cell: (x) => hourLabel(x.hour),
                    csv: (x) => hourLabel(x.hour),
                  },
                  { key: 'n', header: t('opd.visits'), cell: (x) => x.count, csv: (x) => x.count },
                ] satisfies Col<{ hour: number; count: number }>[],
                r.byHour.filter((h) => h.count > 0),
              ),
            ]
          : null
      }
    >
      {!check.success && <FormStatus error={errorText(check.error.issues[0]?.message)} />}
      {q.isPending && check.success && (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />
      )}
      {q.isError && <FormStatus error={errorText(q.error)} />}
      {r && footer && (
        <>
          <section aria-label={t('opd.totals')} className="grid gap-3 sm:grid-cols-3">
            <Tile label={t('opd.visits')} value={r.total} testId="tile-visits" strong />
            <Tile label={t('opd.avgWait')} value={wait(r.avgWaitMinutes)} testId="tile-wait" />
            <Tile label={t('opd.cancelled')} value={r.cancelled} testId="tile-cancelled" />
          </section>
          <ReportTable
            id="opd-doctors"
            caption={t('opd.byDoctor')}
            columns={cols}
            rows={r.rows}
            footer={footer}
            rowKey={(x) => x.doctorId}
            empty={t('empty')}
          />
          {r.total > 0 && (
            <section aria-labelledby="hours-h" className="space-y-2" data-testid="opd-hours">
              <h2 id="hours-h" className="text-xl font-semibold">
                {t('opd.byHour')}
              </h2>
              <div className="overflow-x-auto rounded-lg border bg-card print:overflow-visible">
                <table className="w-full text-center">
                  <thead>
                    <tr className="text-sm text-muted-foreground">
                      {hours.map((h) => (
                        <th key={h.hour} scope="col" className="px-2 py-2">
                          {hourLabel(h.hour)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {hours.map((h) => (
                        <td
                          key={h.hour}
                          data-testid={`hour-${h.hour}`}
                          className={cn('px-2 py-3 text-xl font-bold tabular-nums')}
                          style={{
                            backgroundColor: `color-mix(in srgb, var(--primary) ${Math.round((h.count / peak) * 55)}%, transparent)`,
                          }}
                        >
                          {h.count}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </ReportShell>
  );
}
