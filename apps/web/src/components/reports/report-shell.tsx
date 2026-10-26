'use client';

import {
  addDays,
  formatDate,
  formatDateTime,
  istDateString,
  parseIsoDate,
  toCsv,
  toIsoDate,
  type CsvCell,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Download, Printer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

export interface DateRange {
  from: string;
  to: string;
}

/** Date range state for a report, starting at today (docs/20 §1: "default today"). */
export function useDateRange(): [DateRange, (r: DateRange) => void] {
  const [range, setRange] = useState<DateRange>(() => {
    const today = istDateString(new Date());
    return { from: today, to: today };
  });
  return [range, setRange];
}

const shift = (date: string, days: number) => toIsoDate(addDays(parseIsoDate(date), days));

/** Saves `rows` as a CSV file in the browser; nothing goes to the server. */
function download(rows: CsvCell[][], fileName: string) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Frame of every report (docs/20 §1): title, date range with quick picks, CSV export and an A4
 * print. Controls never print; the print gets a heading with the range and the print time.
 * `csv` is built from the data already on screen, so the export is exactly what the user sees.
 */
export function ReportShell({
  title,
  fileName,
  range,
  onRange,
  csv,
  asOf,
  children,
}: {
  title: string;
  fileName: string;
  /** Null for lists that are "as of now" (ANC register, vaccines due). */
  range: DateRange | null;
  onRange?: (r: DateRange) => void;
  csv: (() => CsvCell[][]) | null;
  asOf?: string;
  children: ReactNode;
}) {
  const t = useTranslations('reports');
  const [printedAt] = useState(() => new Date());
  const today = istDateString(printedAt);
  const subtitle = range
    ? range.from === range.to
      ? formatDate(range.from)
      : t('rangeLine', { from: formatDate(range.from), to: formatDate(range.to) })
    : asOf
      ? t('asOf', { date: formatDate(asOf) })
      : '';
  const quick: [string, DateRange][] = [
    ['today', { from: today, to: today }],
    ['yesterday', { from: shift(today, -1), to: shift(today, -1) }],
    ['last7', { from: shift(today, -6), to: today }],
    ['thisMonth', { from: `${today.slice(0, 8)}01`, to: today }],
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <h1 className="text-3xl font-semibold">{title}</h1>
        <div className="flex flex-wrap gap-3">
          {csv && (
            <Button
              variant="outline"
              size="lg"
              data-testid="export-csv"
              onClick={() => download(csv(), `${fileName}-${range?.from ?? today}.csv`)}
            >
              <Download aria-hidden />
              {t('exportCsv')}
            </Button>
          )}
          <Button
            variant="outline"
            size="lg"
            data-testid="print-report"
            onClick={() => window.print()}
          >
            <Printer aria-hidden />
            {t('print')}
          </Button>
        </div>
      </div>

      {range && onRange && (
        <div className="flex flex-wrap items-end gap-3 print:hidden" data-testid="range-filter">
          <div className="space-y-1">
            <Label htmlFor="report-from">{t('from')}</Label>
            <Input
              id="report-from"
              type="date"
              className="w-44"
              data-testid="report-from"
              value={range.from}
              onChange={(e) => onRange({ ...range, from: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-to">{t('to')}</Label>
            <Input
              id="report-to"
              type="date"
              className="w-44"
              data-testid="report-to"
              value={range.to}
              onChange={(e) => onRange({ ...range, to: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {quick.map(([key, r]) => (
              <Button
                key={key}
                variant="outline"
                onClick={() => onRange(r)}
                data-testid={`range-${key}`}
              >
                {t(`quick.${key as 'today'}`)}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="hidden print:block">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p>{subtitle}</p>
        <p className="text-sm">{t('printedAt', { at: formatDateTime(printedAt) })}</p>
      </div>
      <p className="text-lg text-muted-foreground print:hidden" data-testid="report-subtitle">
        {subtitle}
      </p>

      {children}
    </div>
  );
}
