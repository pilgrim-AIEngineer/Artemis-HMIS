'use client';

import { bpToPercent, type MasterKind } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Dialog, DialogContent } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { createColumnHelper, useTable, type SortingState } from '@tanstack/react-table';
import { ArrowDownAZ, ArrowUpAZ, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useMastersT, type LooseT } from '@/lib/masters-t';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { StatusChip } from '@/components/admin/user-list';
import { cellText, useLookup, useMasterList, useMasterMutation, type Row } from './api';
import { ENUMS, MASTER_DEFS, type ColumnDef, type MasterDef } from './definitions';
import { MasterForm } from './master-form';
import { masterTableFeatures } from './table-features';

const UNDO_MS = 10_000;

/**
 * One master list (docs/02 §8 list rules, docs/05): search focused on load, ↑/↓ to move and Enter
 * to open, empty state, loading skeleton, status text next to colour. Editing happens in a dialog;
 * "remove" is a soft cancel with a reason and a 10-second Undo (docs/05 §1.9).
 */
export function MasterList({ kind }: { kind: MasterKind }) {
  const def = MASTER_DEFS[kind];
  const t = useMastersT();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [active, setActive] = useState(0);
  const [undo, setUndo] = useState<Row | null>(null);
  const restore = useMasterMutation(kind, 'restore');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const list = useMasterList(kind, { search: deferred, includeCancelled, filters });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data]);
  const truncated = list.data?.pages.at(-1)?.truncated ?? false;

  // Names for id columns (department of a doctor, payer of a tariff).
  const departments = useLookup('departments', usesLookup(def, 'departments'));
  const payers = useLookup('payers', usesLookup(def, 'payers'));
  const names = useMemo(
    () => ({
      departments: new Map((departments.data ?? []).map((o) => [o.value, o.label])),
      payers: new Map((payers.data ?? []).map((o) => [o.value, o.label])),
    }),
    [departments.data, payers.data],
  );

  // Columns hidden below `md` (10-inch tablets keep the key columns).
  const secondaryIds = useMemo(
    () => new Set(def.columns.filter((c) => c.secondary).map((c) => c.key)),
    [def],
  );

  const columns = useMemo(() => {
    const helper = createColumnHelper<typeof masterTableFeatures, Row>();
    return helper.columns([
      ...def.columns.map((c, i) =>
        helper.accessor((r) => r[c.key], {
          id: c.key,
          header: t(`fields.${c.key}`),
          cell: ({ row, cell }) => {
            const text = renderValue(c, cell.getValue(), t, names);
            if (i === 0) {
              return (
                <button
                  type="button"
                  onClick={() => setEditing(row.original)}
                  className="rounded text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/60"
                >
                  {text}
                </button>
              );
            }
            return text;
          },
        }),
      ),
      helper.accessor((r) => (r.status === 'cancelled' ? 2 : r.isActive === false ? 1 : 0), {
        id: 'status',
        header: t('fields.status'),
        cell: ({ row }) => <RowStatus row={row.original} />,
      }),
    ]);
  }, [def, t, names]);

  const table = useTable({
    features: masterTableFeatures,
    columns,
    data: rows,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.id,
  });
  const shown = table.getRowModel().rows;

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

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

  const onCancelled = (row: Row) => {
    setEditing(null);
    setUndo(row);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold">{t(`kinds.${kind}.title`)}</h1>
          <p className="max-w-3xl text-muted-foreground">{t(`kinds.${kind}.help`)}</p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          {t(`kinds.${kind}.new`)}
        </Button>
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
        {def.filters?.map((flt) => (
          <Select
            key={flt.name}
            aria-label={t(`fields.${flt.name}`)}
            className="w-auto min-w-44"
            value={filters[flt.name] ?? ''}
            onChange={(e) => {
              setFilters((f) => ({ ...f, [flt.name]: e.target.value }));
              setActive(0);
            }}
          >
            <option value="">{t('allOf', { what: t(`fields.${flt.name}`) })}</option>
            {ENUMS[flt.enum].map((v) => (
              <option key={v} value={v}>
                {t(`enums.${flt.enum}.${v}`)}
              </option>
            ))}
          </Select>
        ))}
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-base">
          <Checkbox
            checked={includeCancelled}
            onChange={(e) => setIncludeCancelled(e.target.checked)}
          />
          {t('showCancelled')}
        </label>
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : list.isError ? (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
          {t('loadFailed')}
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-lg">
          {deferred ? t('noResults') : t(`kinds.${kind}.empty`)}
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
                          secondaryIds.has(h.column.id) && 'hidden md:table-cell',
                        )}
                      >
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex min-h-11 items-center gap-1 rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60"
                        >
                          <table.FlexRender header={h} />
                          {dir === 'asc' && <ArrowDownAZ aria-hidden className="size-4" />}
                          {dir === 'desc' && <ArrowUpAZ aria-hidden className="size-4" />}
                        </button>
                      </th>
                    );
                  })}
                  {def.detailHref && <th scope="col" className="px-4 py-2" />}
                </tr>
              ))}
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr
                  key={r.id}
                  aria-selected={i === active}
                  onDoubleClick={() => setEditing(r.original)}
                  className={cn(
                    'border-t even:bg-muted/40',
                    r.original.status === 'cancelled' && 'text-muted-foreground',
                    i === active && 'outline-2 -outline-offset-2 outline-ring',
                  )}
                >
                  {r.getAllCells().map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        'px-4 py-2',
                        secondaryIds.has(c.column.id) && 'hidden md:table-cell',
                      )}
                    >
                      <table.FlexRender cell={c} />
                    </td>
                  ))}
                  {def.detailHref && (
                    <td className="px-4 py-2 text-right">
                      <Button asChild variant="outline" size="sm">
                        <Link href={def.detailHref(r.original)}>{t('openRates')}</Link>
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {truncated && <p className="text-muted-foreground">{t('truncated')}</p>}
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
          {editing !== null && (
            <MasterForm
              key={editing === 'new' ? 'new' : editing.id}
              def={def}
              row={editing === 'new' ? null : editing}
              onSaved={() => setEditing(null)}
              onCancelled={onCancelled}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {undo && (
        <div
          role="status"
          className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border-2 bg-card p-3 shadow-lg"
        >
          <span>{t('removed', { name: cellText(undo[def.titleKey]) })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={restore.isPending}
            onClick={() => void restore.mutateAsync({ id: undo.id }).then(() => setUndo(null))}
          >
            {t('undo')}
          </Button>
        </div>
      )}
    </div>
  );
}

const usesLookup = (def: MasterDef, name: 'departments' | 'payers') =>
  def.columns.some((c) => c.from === name);

function RowStatus({ row }: { row: Row }) {
  const t = useMastersT();
  if (row.status === 'cancelled') return <StatusChip label={t('status.cancelled')} tone="danger" />;
  if (row.isActive === false) return <StatusChip label={t('status.inactive')} tone="muted" />;
  return <StatusChip label={t('status.active')} tone="ok" />;
}

type T = LooseT;

function renderValue(
  c: ColumnDef,
  value: unknown,
  t: T,
  names: { departments: Map<string, string>; payers: Map<string, string> },
): string {
  if (value === null || value === undefined || value === '') {
    return c.key === 'payerId' ? t('allPayers') : '—';
  }
  switch (c.as) {
    case 'enum':
      return t(`enums.${c.enum}.${cellText(value)}`);
    case 'bool':
      return value ? t('yes') : t('no');
    case 'gst':
      return typeof value === 'number' ? `${bpToPercent(value)}%` : '—';
    case 'days':
      return Array.isArray(value) && value.length
        ? value.map((d) => t(`enums.weekday.${String(d)}`)).join(', ')
        : '—';
    case 'lookup':
      return (c.from === 'payers' ? names.payers : names.departments).get(cellText(value)) ?? '…';
    default:
      return cellText(value);
  }
}
