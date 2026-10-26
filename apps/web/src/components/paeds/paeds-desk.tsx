'use client';

import { formatDate } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import { Syringe, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAgeText } from '@/lib/use-age-text';
import { useDebounced } from '@/lib/use-debounced';
import { useTRPC } from '@/trpc/client';
import { SignOffBanner } from './paeds-common';

/**
 * Paediatrics desk (OPD-06): find a child by name, mobile or UHID and open the vaccination and
 * growth card, or pick one of the children whose next vaccines fall due soon. Keyboard: type,
 * ↑/↓, Enter.
 */
export function PaedsDesk() {
  const t = useTranslations('paeds');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const ageText = useAgeText();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 150);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const due = useQuery(trpc.paeds.dueSoon.queryOptions());
  const rules = useQuery(trpc.paeds.rules.queryOptions());
  const search = useQuery(
    trpc.patients.search.queryOptions(debounced ? { q: debounced } : skipToken, {
      placeholderData: keepPreviousData,
    }),
  );
  const rows = debounced ? (search.data?.rows ?? []) : [];
  const open = (patientId: string) => router.push(`/assistant/paeds/${patientId}`);
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
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('deskTitle')}</h1>
        <p className="text-lg text-muted-foreground">{t('deskHint')}</p>
      </div>
      {rules.data && <SignOffBanner signedOff={rules.data.signedOff} />}

      <div className="space-y-2">
        <label htmlFor="paeds-search" className="text-lg font-medium">
          {t('search')}
        </label>
        <div className="relative">
          <Search
            aria-hidden
            className="absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="paeds-search"
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            className="h-14 pl-11 text-xl"
            placeholder={t('searchHint')}
          />
        </div>
        {debounced && search.data && rows.length === 0 && (
          <p className="text-muted-foreground">{t('noPatient')}</p>
        )}
        {rows.length > 0 && (
          <ul className="space-y-2" data-testid="paeds-search-results">
            {rows.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open(r.id)}
                  aria-current={i === active || undefined}
                  className="flex min-h-14 w-full flex-wrap items-center gap-x-4 rounded-lg border-2 bg-card px-4 py-2 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/60 aria-[current]:border-primary"
                >
                  <span className="text-xl font-semibold">
                    {locale === 'hi' && r.nameHi ? r.nameHi : r.fullName}
                  </span>
                  <span className="text-muted-foreground">
                    {ageText(r.dob)} · {r.uhid}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section aria-labelledby="paeds-due" className="space-y-3">
        <h2 id="paeds-due" className="text-2xl font-semibold">
          {t('dueTitle')}
          {due.data && <span className="ml-2 text-muted-foreground">({due.data.length})</span>}
        </h2>
        {due.isError && (
          <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
            {t('loadFailed')}
          </p>
        )}
        {due.data && due.data.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
            {t('nobodyDue')}
          </p>
        ) : (
          <ul className="space-y-3" data-testid="paeds-due-list">
            {due.data?.map((c) => (
              <li
                key={c.patientId}
                className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border-2 bg-card p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-xl font-semibold">{c.name}</p>
                  <p className="text-muted-foreground">
                    {c.uhid} · {ageText(c.dob)}
                  </p>
                  <p className={c.daysFromToday < 0 ? 'font-semibold text-destructive' : ''}>
                    {t('nextDue')}: {formatDate(c.nextDueDate)}
                    {c.daysFromToday < 0
                      ? ` · ${t('overdueBy', { count: -c.daysFromToday })}`
                      : c.daysFromToday === 0
                        ? ` · ${t('dueToday')}`
                        : ` · ${t('dueIn', { count: c.daysFromToday })}`}
                  </p>
                </div>
                <Button asChild size="lg" variant="outline">
                  <Link href={`/assistant/paeds/${c.patientId}`}>
                    <Syringe aria-hidden />
                    {t('openCard')}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
