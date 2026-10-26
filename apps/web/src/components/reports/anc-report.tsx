'use client';

import { formatDate } from '@hmis/shared';
import { Label } from '@hmis/ui/components/label';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { riskLabel } from '@/components/anc/anc-common';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { ReportShell } from './report-shell';
import { csvSection, ReportTable, Tile, type Col } from './report-table';

type Register = inferRouterOutputs<AppRouter>['reports']['ancRegister'];
type Row = Register['rows'][number];

/**
 * ANC register (RPT-01, docs/20 §2): active pregnancies with GA today, EDD, risk flags and the
 * visit that is due, with the lists the front desk phones from: EDDs in the next 30 days and
 * women who missed their visit by more than a week. The risk filter is the high-risk list.
 */
export function AncReport() {
  const t = useTranslations('reports');
  const tAnc = useTranslations('anc');
  const tAge = useTranslations('age');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [risk, setRisk] = useState('');
  const q = useQuery(trpc.reports.ancRegister.queryOptions({ eddWithinDays: 30 }));
  const r = q.data;

  const risks = (x: Row) =>
    x.risks
      .map((f) => (f.text ? `${riskLabel(tAnc, f.code)}: ${f.text}` : riskLabel(tAnc, f.code)))
      .join('; ');
  const age = (x: Row) => tAge(x.age.unit, { count: x.age.value });
  const name = (x: Row) => (locale === 'hi' && x.nameHi ? x.nameHi : x.fullName);
  const base: Col<Row>[] = [
    { key: 'uhid', header: t('anc.uhid'), cell: (x) => x.uhid, csv: (x) => x.uhid },
    { key: 'name', header: t('anc.name'), cell: (x) => name(x), csv: (x) => name(x) },
    { key: 'age', header: t('anc.age'), cell: age, csv: age },
    { key: 'mobile', header: t('anc.mobile'), cell: (x) => x.mobile ?? '', csv: (x) => x.mobile },
    { key: 'ga', header: t('anc.ga'), cell: (x) => x.gaLabel, csv: (x) => x.gaLabel },
    {
      key: 'edd',
      header: t('anc.edd'),
      cell: (x) => formatDate(x.eddFinal),
      csv: (x) => formatDate(x.eddFinal),
    },
  ];
  const register: Col<Row>[] = [
    ...base,
    { key: 'gpal', header: t('anc.gpal'), cell: (x) => x.gpalText, csv: (x) => x.gpalText },
    { key: 'risks', header: t('anc.risks'), cell: risks, csv: risks },
    {
      key: 'last',
      header: t('anc.lastVisit'),
      cell: (x) => (x.lastVisit ? formatDate(x.lastVisit) : '—'),
      csv: (x) => (x.lastVisit ? formatDate(x.lastVisit) : ''),
    },
    {
      key: 'next',
      header: t('anc.nextVisit'),
      cell: (x) => (x.nextVisitDate ? formatDate(x.nextVisitDate) : '—'),
      csv: (x) => (x.nextVisitDate ? formatDate(x.nextVisitDate) : ''),
    },
  ];
  const overdue: Col<Row>[] = [
    ...base,
    {
      key: 'last',
      header: t('anc.lastVisit'),
      cell: (x) => (x.lastVisit ? formatDate(x.lastVisit) : '—'),
      csv: (x) => (x.lastVisit ? formatDate(x.lastVisit) : ''),
    },
    {
      key: 'next',
      header: t('anc.nextVisit'),
      cell: (x) => (x.nextVisitDate ? formatDate(x.nextVisitDate) : '—'),
      csv: (x) => (x.nextVisitDate ? formatDate(x.nextVisitDate) : ''),
    },
    {
      key: 'late',
      header: t('anc.daysLate'),
      cell: (x) => x.daysLate,
      csv: (x) => x.daysLate,
      right: true,
    },
  ];
  const edd: Col<Row>[] = [
    ...base,
    {
      key: 'toEdd',
      header: t('anc.daysToEdd'),
      cell: (x) => x.daysToEdd,
      csv: (x) => x.daysToEdd,
      right: true,
    },
    { key: 'risks', header: t('anc.risks'), cell: risks, csv: risks },
  ];

  const codes = r ? [...new Set(r.rows.flatMap((x) => x.risks.map((f) => f.code)))].sort() : [];
  const keep = (x: Row) => !risk || x.risks.some((f) => f.code === risk);
  const rows = r?.rows.filter(keep) ?? [];

  return (
    <ReportShell
      title={t('tiles.anc.title')}
      fileName="anc-register"
      range={null}
      asOf={r?.today}
      csv={
        r
          ? () => [
              ...csvSection(t('anc.overdue'), overdue, r.overdue.filter(keep)),
              ...csvSection(t('anc.eddSoon'), edd, r.eddSoon.filter(keep)),
              ...csvSection(t('anc.register'), register, rows),
            ]
          : null
      }
    >
      {q.isPending && <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />}
      {q.isError && <FormStatus error={errorText(q.error)} />}
      {r && (
        <>
          <section
            aria-label={t('anc.totals')}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Tile label={t('anc.active')} value={r.rows.length} testId="tile-active" strong />
            <Tile label={t('anc.highRisk')} value={r.highRiskCount} testId="tile-high-risk" />
            <Tile label={t('anc.eddSoon')} value={r.eddSoon.length} testId="tile-edd" />
            <Tile
              label={t('anc.overdue')}
              value={r.overdue.length}
              testId="tile-overdue"
              tone={r.overdue.length ? 'alert' : undefined}
            />
          </section>
          {codes.length > 0 && (
            <div className="max-w-sm space-y-1 print:hidden">
              <Label htmlFor="risk-filter">{t('anc.riskFilter')}</Label>
              <select
                id="risk-filter"
                data-testid="risk-filter"
                className="h-12 w-full rounded-md border-2 bg-background px-3 text-lg"
                value={risk}
                onChange={(e) => setRisk(e.target.value)}
              >
                <option value="">{t('anc.allRisks')}</option>
                {codes.map((c) => (
                  <option key={c} value={c}>
                    {riskLabel(tAnc, c)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ReportTable
            id="anc-overdue"
            caption={t('anc.overdueCaption')}
            columns={overdue}
            rows={r.overdue.filter(keep)}
            rowKey={(x) => x.pregnancyId}
            empty={t('anc.noOverdue')}
          />
          <ReportTable
            id="anc-edd"
            caption={t('anc.eddCaption')}
            columns={edd}
            rows={r.eddSoon.filter(keep)}
            rowKey={(x) => x.pregnancyId}
            empty={t('anc.noEdd')}
          />
          <ReportTable
            id="anc-register"
            caption={t('anc.register')}
            columns={register}
            rows={rows}
            rowKey={(x) => x.pregnancyId}
            empty={t('empty')}
          />
        </>
      )}
    </ReportShell>
  );
}
