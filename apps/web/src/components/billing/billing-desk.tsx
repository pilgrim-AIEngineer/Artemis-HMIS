'use client';

import { formatINR } from '@hmis/shared';
import { Input } from '@hmis/ui/components/input';
import { cn } from '@hmis/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useDebounced } from '@/lib/use-debounced';
import { useTRPC } from '@/trpc/client';
import { BillStatusChip } from './bill-screen';

/**
 * Billing desk (BIL-01, docs/05 §1.5): bills waiting for money, newest first, with a search box
 * focused on load (UHID, mobile, name or visit number). ↑/↓ move, Enter opens the bill.
 */
export function BillingDesk() {
  const t = useTranslations('billing');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 200);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const pending = useQuery(
    trpc.billing.pending.queryOptions(
      { q: debounced || undefined },
      { placeholderData: keepPreviousData, refetchInterval: 15_000 },
    ),
  );
  const rows = pending.data ?? [];
  useEffect(() => input.current?.focus(), []);

  const open = (id: string) => router.push(`/billing/bills/${id}`);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      open(rows[active].id);
    }
  };

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-semibold">{t('deskTitle')}</h1>
      <div className="relative max-w-2xl">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-6 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={input}
          type="search"
          role="combobox"
          autoComplete="off"
          aria-label={t('search')}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={rows[active] ? `${listId}-${rows[active].id}` : undefined}
          placeholder={t('searchPlaceholder')}
          className="min-h-14 pl-12 text-xl"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div aria-live="polite">
        {pending.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="max-w-3xl rounded-lg border bg-card p-6 text-lg">
            {debounced ? t('noMatch') : t('nothingPending')}
          </p>
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('pendingList')}
            className="divide-y overflow-hidden rounded-lg border bg-card"
          >
            {rows.map((r, i) => (
              <li
                key={r.id}
                id={`${listId}-${r.id}`}
                role="option"
                aria-selected={i === active}
                onClick={() => open(r.id)}
                onMouseMove={() => i !== active && setActive(i)}
                className={cn(
                  'grid min-h-16 cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[2fr_1.5fr_auto_auto]',
                  i === active && 'bg-accent outline-2 -outline-offset-2 outline-ring',
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">
                    {locale === 'hi' && r.patientNameHi ? r.patientNameHi : r.patientName}
                  </p>
                  <p className="text-muted-foreground tabular-nums">
                    {r.uhid}
                    {r.mobile && ` · ••••${r.mobile.slice(-4)}`}
                  </p>
                </div>
                <p className="hidden md:block">
                  {r.encounterNumber} · {r.doctorName}
                  {r.tokenNo !== null && ` · ${t('tokenNo', { token: r.tokenNo })}`}
                </p>
                <BillStatusChip status={r.status} />
                <p className="text-right text-xl font-bold tabular-nums">
                  {formatINR(r.balancePaise)}
                  <span className="block text-sm font-normal text-muted-foreground">
                    {t('due')}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
