'use client';

import { formatDate, formatINR } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { cn } from '@hmis/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { Tile } from './report-table';

/** The owner's page refreshes by itself once a minute while it is open. */
const REFRESH_MS = 60_000;

/** Line of 30 daily values; the figures beside it carry the information, the line shows the shape. */
function Trend({ values, label, testId }: { values: number[]; label: string; testId: string }) {
  const max = Math.max(1, ...values);
  const w = 300;
  const h = 70;
  const pts = values
    .map(
      (v, i) =>
        `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 4 - (v / max) * (h - 8)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
      className="h-20 w-full text-primary"
      data-testid={testId}
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** `+12%` / `−5%` against a base; blank when there is no base to compare with. */
function change(now: bigint | number, base: bigint | number): string | null {
  const n = Number(now);
  const b = Number(base);
  if (b <= 0) return null;
  const pct = Math.round(((n - b) / b) * 100);
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

/**
 * Owner dashboard (RPT-02, docs/20 §3): read-only, one column, big numbers, for the owner's phone.
 * Today (OPD by doctor, who is waiting, collection by mode, discounts, cancellations with names),
 * the last 30 days, this month against last month, and what needs attention. Phase 2 tiles
 * (admissions, deliveries, beds, pharmacy, lab) join when those modules exist.
 */
export function OwnerDashboard() {
  const t = useTranslations('reports.dashboard');
  const tMode = useTranslations('reports.mode');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.reports.dashboard.queryOptions(), refetchInterval: REFRESH_MS });
  const d = q.data;

  if (q.isPending) return <div className="h-96 animate-pulse rounded-lg bg-muted" aria-busy />;
  if (!d) return <FormStatus error={errorText(q.error)} />;

  const money = (p: bigint) => formatINR(p, { decimals: 'auto' });
  const opdChange = change(d.month.opd, d.month.prevSamePeriod.opd);
  const revChange = change(d.month.netPaise, d.month.prevSamePeriod.netPaise);

  return (
    <div className="mx-auto max-w-xl space-y-6" data-testid="owner-dashboard">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground" data-testid="dashboard-date">
            {formatDate(d.today)}
          </p>
        </div>
        <Button
          variant="outline"
          size="lg"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          data-testid="dashboard-refresh"
        >
          <RefreshCw aria-hidden className={cn(q.isFetching && 'animate-spin')} />
          {t('refresh')}
        </Button>
      </div>
      {q.isError && <FormStatus error={errorText(q.error)} />}

      <section aria-labelledby="alerts-h" className="space-y-2" data-testid="dashboard-alerts">
        <h2 id="alerts-h" className="text-xl font-semibold">
          {t('alerts')}
        </h2>
        {d.alerts.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-lg">{t('noAlerts')}</p>
        ) : (
          <ul className="space-y-2">
            {d.alerts.map((a, i) => (
              <li
                key={`${a.kind}-${a.ref}-${i}`}
                role="alert"
                className="flex items-start gap-3 rounded-lg border-2 border-destructive bg-card p-3 text-lg"
                data-testid="alert-item"
              >
                <TriangleAlert aria-hidden className="mt-1 size-5 shrink-0 text-destructive" />
                <span>
                  {a.kind === 'dayCloseDifference'
                    ? t('alertDayClose', { ref: a.ref, amount: money(a.paise ?? 0n) })
                    : t('alertUpi', { date: formatDate(a.ref) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="today-h" className="space-y-3">
        <h2 id="today-h" className="text-xl font-semibold">
          {t('today')}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Tile label={t('opdToday')} value={d.opdToday.total} testId="dash-opd" strong />
          <Tile label={t('waiting')} value={d.waiting} testId="dash-waiting" />
          <Tile
            label={t('collection')}
            value={money(d.collectionToday.netPaise)}
            testId="dash-net"
            strong
          />
          <Tile
            label={t('discounts')}
            value={money(d.discountsToday.totalPaise)}
            testId="dash-discounts"
          />
        </div>
        {d.opdToday.byDoctor.length > 0 && (
          <ul className="divide-y rounded-lg border bg-card" data-testid="dash-doctors">
            {d.opdToday.byDoctor.map((x) => (
              <li key={x.doctor} className="flex justify-between gap-3 px-4 py-2 text-lg">
                <span>{x.doctor}</span>
                <span className="font-bold tabular-nums">{x.count}</span>
              </li>
            ))}
          </ul>
        )}
        <ul className="divide-y rounded-lg border bg-card" data-testid="dash-modes">
          {(
            [
              ['cash', d.collectionToday.cashPaise],
              ['upi', d.collectionToday.upiPaise],
              ['card', d.collectionToday.cardPaise],
              ['other', d.collectionToday.otherPaise],
            ] as const
          )
            .filter(([m, p]) => m !== 'other' || p !== 0n)
            .map(([m, p]) => (
              <li key={m} className="flex justify-between gap-3 px-4 py-2 text-lg">
                <span>{tMode(m)}</span>
                <span className="font-bold tabular-nums">{money(p)}</span>
              </li>
            ))}
          {d.collectionToday.refundedPaise > 0n && (
            <li className="flex justify-between gap-3 px-4 py-2 text-lg text-muted-foreground">
              <span>{t('refunds')}</span>
              <span className="tabular-nums">{money(d.collectionToday.refundedPaise)}</span>
            </li>
          )}
        </ul>
      </section>

      <section aria-labelledby="cancel-h" className="space-y-2" data-testid="dash-cancellations">
        <h2 id="cancel-h" className="text-xl font-semibold">
          {t('cancellations')}
        </h2>
        {d.cancellationsToday.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-lg">{t('noCancellations')}</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {d.cancellationsToday.map((c) => (
              <li
                key={c.number}
                className="space-y-0.5 px-4 py-2 text-lg"
                data-testid="cancellation-item"
              >
                <p className="flex justify-between gap-3">
                  <span className="font-semibold">{c.patientName}</span>
                  <span className="font-bold tabular-nums">{money(c.amountPaise)}</span>
                </p>
                <p className="text-base text-muted-foreground">
                  {c.uhid} · {c.reasonLabel}
                  {c.issuedByName ? ` · ${c.issuedByName}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="trend-h" className="space-y-3">
        <h2 id="trend-h" className="text-xl font-semibold">
          {t('trend')}
        </h2>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-muted-foreground">{t('trendOpd')}</p>
          <Trend values={d.trend.map((x) => x.opd)} label={t('trendOpd')} testId="trend-opd" />
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-muted-foreground">{t('trendRevenue')}</p>
          <Trend
            values={d.trend.map((x) => Number(x.netPaise))}
            label={t('trendRevenue')}
            testId="trend-revenue"
          />
        </div>
      </section>

      <section aria-labelledby="month-h" className="space-y-3" data-testid="dash-month">
        <h2 id="month-h" className="text-xl font-semibold">
          {t('month')}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Tile label={t('monthOpd')} value={d.month.opd} testId="month-opd" />
          <Tile label={t('monthRevenue')} value={money(d.month.netPaise)} testId="month-revenue" />
        </div>
        <p className="text-lg text-muted-foreground" data-testid="month-compare">
          {t('monthCompare', {
            opd: d.month.prevSamePeriod.opd,
            revenue: money(d.month.prevSamePeriod.netPaise),
            opdChange: opdChange ?? '—',
            revenueChange: revChange ?? '—',
          })}
        </p>
        <p className="text-lg text-muted-foreground">
          {t('lastMonthTotal', {
            opd: d.month.prevFull.opd,
            revenue: money(d.month.prevFull.netPaise),
          })}
        </p>
      </section>
    </div>
  );
}
