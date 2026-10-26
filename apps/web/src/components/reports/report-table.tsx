'use client';

import type { CsvCell } from '@hmis/shared';
import { cn } from '@hmis/ui/lib/utils';
import type { ReactNode } from 'react';

/**
 * One column of a report table. `cell` is what the screen shows, `csv` what the export writes
 * (plain values, rupees as decimals), so a screen and its CSV can never drift apart.
 */
export interface Col<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  csv: (row: T) => CsvCell;
  right?: boolean;
}

export interface Footer<T> {
  label: string;
  /** Per column key; columns not listed stay blank. */
  cells: Partial<Record<string, { cell: ReactNode; csv: CsvCell }>>;
  /** `T` only ties the footer to its table's columns. */
  _row?: T;
}

/** Table of a report: sticky-free, scrolls sideways on a phone, prints as plain rules. */
export function ReportTable<T>({
  id,
  caption,
  columns,
  rows,
  footer,
  rowKey,
  empty,
}: {
  id: string;
  caption: string;
  columns: Col<T>[];
  rows: T[];
  footer?: Footer<T>;
  rowKey: (row: T, i: number) => string;
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <section aria-label={caption} className="space-y-2" data-testid={`${id}-section`}>
        <h2 className="text-xl font-semibold">{caption}</h2>
        <p className="rounded-lg border bg-card p-4 text-lg">{empty}</p>
      </section>
    );
  }
  return (
    <section aria-label={caption} className="space-y-2" data-testid={`${id}-section`}>
      <h2 className="text-xl font-semibold">{caption}</h2>
      <div className="overflow-x-auto rounded-lg border bg-card print:overflow-visible print:border-0">
        <table className="w-full text-base print:text-xs" data-testid={id}>
          <thead>
            <tr className="border-b text-left text-sm text-muted-foreground print:text-xs">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2', c.right && 'text-right')}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={rowKey(r, i)} className="border-b last:border-0" data-testid={`${id}-row`}>
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2', c.right && 'text-right tabular-nums')}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot>
              <tr className="border-t-2 font-bold" data-testid={`${id}-total`}>
                {columns.map((c, i) => (
                  <td key={c.key} className={cn('px-3 py-2', c.right && 'text-right tabular-nums')}>
                    {i === 0 ? footer.label : (footer.cells[c.key]?.cell ?? '')}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

/** A titled block of CSV rows for one table: title, header, rows, totals, then a blank line. */
export function csvSection<T>(
  title: string,
  columns: Col<T>[],
  rows: T[],
  footer?: Footer<T>,
): CsvCell[][] {
  const out: CsvCell[][] = [[title], columns.map((c) => c.header)];
  for (const r of rows) out.push(columns.map((c) => c.csv(r)));
  if (footer) {
    out.push(columns.map((c, i) => (i === 0 ? footer.label : (footer.cells[c.key]?.csv ?? ''))));
  }
  out.push([]);
  return out;
}

/** Big figure tile used at the top of a report and on the dashboard. */
export function Tile({
  label,
  value,
  testId,
  tone,
  strong,
}: {
  label: string;
  value: ReactNode;
  testId?: string;
  tone?: 'alert';
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-4',
        strong && 'border-2',
        tone === 'alert' && 'border-destructive',
      )}
      data-testid={testId}
    >
      <p className="text-muted-foreground">{label}</p>
      <p className="text-3xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
