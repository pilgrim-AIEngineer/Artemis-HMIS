'use client';

import {
  formatDate,
  formatDateTime,
  formatINR,
  istToday,
  rupeesToPaise,
  SERVICE_CATEGORIES,
  toIsoDate,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, useTable, type SortingState } from '@tanstack/react-table';
import { ArrowLeft, Search } from 'lucide-react';
import Link from 'next/link';
import { useMastersT } from '@/lib/masters-t';
import { useDeferredValue, useMemo, useState, type KeyboardEvent } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useMastersCall } from './api';
import { masterTableFeatures } from './table-features';

/** Columns hidden below `md` (10-inch tablets keep the key columns). */
const SECONDARY = new Set(['category', 'from']);

interface RateRow {
  serviceId: string;
  code: string;
  name: string;
  nameHi: string | null;
  category: string;
  unit: string;
  ratePaise: bigint | null;
  effectiveFrom: string | null;
  nextChangeFrom: string | null;
}

interface RatePage {
  rows: RateRow[];
  nextCursor: string | null;
  today: string;
}

interface HistoryRow {
  id: string;
  ratePaise: bigint;
  effectiveFrom: string;
  status: string;
  cancelReason: string | null;
  createdAt: Date;
}

/** Rupees as typed: digits with up to two decimals. Converted to paise at the edge only. */
const RUPEE_RE = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * Rates of one tariff (docs/12 §1): every active service with its price today, "—" where none is
 * set. Setting a rate adds an effective-dated row; old bills keep their snapshot.
 */
export function RatesList({ tariffId, tariffName }: { tariffId: string; tariffName: string }) {
  const t = useMastersT();
  const call = useMastersCall();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const [category, setCategory] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editing, setEditing] = useState<RateRow | null>(null);
  const [active, setActive] = useState(0);

  const list = useInfiniteQuery({
    queryKey: ['masters', 'rates', tariffId, deferred, category, onlyMissing],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      call('listServiceRates', 'query', {
        tariffId,
        search: deferred || undefined,
        category: category || undefined,
        onlyMissing,
        limit: 50,
        cursor: pageParam,
      }) as Promise<RatePage>,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data]);
  const today = list.data?.pages[0]?.today ?? toIsoDate(istToday());

  const columns = useMemo(() => {
    const helper = createColumnHelper<typeof masterTableFeatures, RateRow>();
    return helper.columns([
      helper.accessor('name', {
        header: t('fields.service'),
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setEditing(row.original)}
            className="rounded text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/60"
          >
            {row.original.name}
            <span className="block font-mono text-sm font-normal text-muted-foreground">
              {row.original.code}
            </span>
          </button>
        ),
      }),
      helper.accessor('category', {
        header: t('fields.category'),
        cell: ({ cell }) => t(`enums.serviceCategory.${cell.getValue()}`),
      }),
      helper.accessor((r) => (r.ratePaise === null ? -1 : Number(r.ratePaise)), {
        id: 'rate',
        header: t('rates.rate'),
        cell: ({ row }) =>
          row.original.ratePaise === null ? (
            <span className="text-muted-foreground">{t('rates.noRate')}</span>
          ) : (
            <span className="font-medium tabular-nums">{formatINR(row.original.ratePaise)}</span>
          ),
      }),
      helper.accessor((r) => r.effectiveFrom ?? '', {
        id: 'from',
        header: t('rates.since'),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.effectiveFrom ? formatDate(row.original.effectiveFrom) : '—'}
            {row.original.nextChangeFrom && (
              <span className="block text-sm text-muted-foreground">
                {t('rates.changesOn', { date: formatDate(row.original.nextChangeFrom) })}
              </span>
            )}
          </span>
        ),
      }),
    ]);
  }, [t]);
  const table = useTable({
    features: masterTableFeatures,
    columns,
    data: rows,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.serviceId,
  });
  const shown = table.getRowModel().rows;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault();
      setEditing(shown[active].original);
    }
  };

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="sm">
        <Link href="/admin/masters/tariffs">
          <ArrowLeft aria-hidden />
          {t('rates.back')}
        </Link>
      </Button>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('rates.title', { tariff: tariffName })}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('rates.help')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1 sm:max-w-md">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            autoFocus
            aria-label={t('search')}
            placeholder={t('searchPlaceholder')}
            className="pl-10"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <Select
          aria-label={t('fields.category')}
          className="w-auto min-w-44"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('allOf', { what: t('fields.category') })}</option>
          {SERVICE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`enums.serviceCategory.${c}`)}
            </option>
          ))}
        </Select>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-base">
          <Checkbox checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          {t('rates.onlyMissing')}
        </label>
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-lg">
          {onlyMissing && !deferred ? t('rates.allPriced') : t('noResults')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-secondary">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const dir = h.column.getIsSorted();
                    return (
                      <th
                        key={h.id}
                        scope="col"
                        aria-sort={
                          dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'
                        }
                        className={cn(
                          'px-4 py-2 font-semibold',
                          SECONDARY.has(h.column.id) && 'hidden md:table-cell',
                          h.column.id === 'rate' && 'text-right',
                        )}
                      >
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex min-h-11 items-center rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60"
                        >
                          <table.FlexRender header={h} />
                          {dir === 'asc' ? ' ↑' : dir === 'desc' ? ' ↓' : ''}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr
                  key={r.id}
                  aria-selected={i === active}
                  className={cn(
                    'border-t even:bg-muted/40',
                    i === active && 'outline-2 -outline-offset-2 outline-ring',
                  )}
                >
                  {r.getAllCells().map((c) => {
                    return (
                      <td
                        key={c.id}
                        className={cn(
                          'px-4 py-2',
                          SECONDARY.has(c.column.id) && 'hidden md:table-cell',
                          c.column.id === 'rate' && 'text-right',
                        )}
                      >
                        <table.FlexRender cell={c} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent closeLabel={t('close')}>
          {editing && (
            <RateForm
              key={editing.serviceId}
              tariffId={tariffId}
              row={editing}
              today={today}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RateForm({
  tariffId,
  row,
  today,
  onDone,
}: {
  tariffId: string;
  row: RateRow;
  today: string;
  onDone: () => void;
}) {
  const t = useMastersT();
  const errorText = useErrorText();
  const call = useMastersCall();
  const qc = useQueryClient();
  const [rupees, setRupees] = useState('');
  const [from, setFrom] = useState(today);
  const [error, setError] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['masters', 'rate-history', tariffId, row.serviceId],
    queryFn: () =>
      call('listRateHistory', 'query', { serviceId: row.serviceId, tariffId }) as Promise<
        HistoryRow[]
      >,
  });
  const save = useMutation({
    mutationFn: (input: unknown) => call('setServiceRate', 'mutate', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['masters'] }),
  });

  const valid = RUPEE_RE.test(rupees.trim());
  const preview = valid ? formatINR(rupeesToPaise(rupees.trim())) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!valid) {
      setError(t('rates.invalidAmount'));
      return;
    }
    try {
      await save.mutateAsync({
        serviceId: row.serviceId,
        tariffId,
        ratePaise: rupeesToPaise(rupees.trim()).toString(),
        effectiveFrom: from,
      });
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <DialogTitle>{row.name}</DialogTitle>
        <DialogDescription>
          {row.ratePaise === null
            ? t('rates.noRateYet')
            : t('rates.currentRate', { rate: formatINR(row.ratePaise) })}
        </DialogDescription>
      </div>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="rate-inr">{t('rates.newRate')}</Label>
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              >
                ₹
              </span>
              <Input
                id="rate-inr"
                autoFocus
                inputMode="decimal"
                autoComplete="off"
                className="pl-8 text-right text-xl tabular-nums"
                value={rupees}
                aria-invalid={rupees !== '' && !valid ? true : undefined}
                onChange={(e) => setRupees(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </div>
            <p className="min-h-7 text-xl font-semibold tabular-nums" aria-live="polite">
              {preview}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rate-from">{t('rates.effectiveFrom')}</Label>
            <Input
              id="rate-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">{t('rates.effectiveHelp')}</p>
          </div>
        </div>
        <FormStatus error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('close')}
          </Button>
          <Button type="submit" variant="money" disabled={save.isPending || !valid || !from}>
            {t('rates.save')}
          </Button>
        </div>
      </form>

      <section aria-labelledby="rate-history" className="space-y-2 border-t pt-4">
        <h3 id="rate-history" className="text-lg font-semibold">
          {t('rates.history')}
        </h3>
        {history.isPending ? (
          <div className="h-12 animate-pulse rounded-md bg-muted" aria-busy="true" />
        ) : (history.data ?? []).length === 0 ? (
          <p className="text-muted-foreground">{t('rates.noHistory')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {(history.data ?? []).map((h) => (
              <li
                key={h.id}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-2 px-3 py-2',
                  h.status === 'cancelled' && 'text-muted-foreground line-through',
                )}
              >
                <span className="tabular-nums">
                  {formatDate(h.effectiveFrom)} · {formatINR(h.ratePaise)}
                </span>
                <span className="text-sm no-underline">
                  {h.status === 'cancelled' ? t('rates.replaced') : formatDateTime(h.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
