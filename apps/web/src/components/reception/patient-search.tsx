'use client';

import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import { Input } from '@hmis/ui/components/input';
import { Button } from '@hmis/ui/components/button';
import { cn } from '@hmis/ui/lib/utils';
import { Search, UserRoundPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useAgeText } from '@/lib/use-age-text';
import { useDebounced } from '@/lib/use-debounced';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';

/**
 * Reception home (REG-02, docs/10 §2, docs/05 §1.5): one search box, focused on load. Digits find
 * a mobile or UHID, letters a name (any common spelling). ↑/↓ move, Enter opens, F2 registers a new
 * patient. A mobile search lists the whole family on that number.
 */
export function PatientSearch({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations('reception');
  const trpc = useTRPC();
  const router = useRouter();
  const ageText = useAgeText();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 150);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const search = useQuery(
    trpc.patients.search.queryOptions(debounced ? { q: debounced } : skipToken, {
      placeholderData: keepPreviousData,
    }),
  );
  const rows = debounced ? (search.data?.rows ?? []) : [];

  // A new result list starts at its first row (state adjusted during render, not in an effect).
  const [seen, setSeen] = useState(search.data);
  if (seen !== search.data) {
    setSeen(search.data);
    setActive(0);
  }
  // Focus the search box whenever the screen is shown (also when returning with the back button).
  useEffect(() => input.current?.focus(), []);

  useShortcut('F2', () => router.push('/reception/patients/new'), canCreate);

  const open = (id: string) => router.push(`/reception/patients/${id}`);
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

  const family = search.data?.family && rows.length > 0 ? rows : null;
  const last4 = family?.[0]?.mobile?.slice(-4);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/reception/patients/new">
              <UserRoundPlus aria-hidden />
              {t('newPatient')}
              <ShortcutHint keys="F2" />
            </Link>
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <div className="relative max-w-2xl">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-6 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={input}
            type="search"
            role="combobox"
            autoFocus
            autoComplete="off"
            aria-label={t('search.label')}
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={rows[active] ? `${listId}-${rows[active].id}` : undefined}
            placeholder={t('search.placeholder')}
            className="min-h-14 pl-12 text-xl"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <p className="max-w-3xl text-muted-foreground">{t('search.hint')}</p>
      </div>

      <div aria-live="polite">
        {!debounced ? (
          <p className="max-w-3xl rounded-lg border bg-card p-6 text-lg">{t('search.start')}</p>
        ) : search.isError ? (
          <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
            {t('search.failed')}
          </p>
        ) : search.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="max-w-3xl rounded-lg border bg-card p-6 text-lg">{t('search.none')}</p>
        ) : (
          <div className="space-y-3">
            {family ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-xl font-semibold">
                    <Users aria-hidden className="size-6" />
                    {t('search.family', { last4: last4 ?? '' })}
                  </h2>
                  <p className="text-muted-foreground">{t('search.familyHint')}</p>
                </div>
                {canCreate && (
                  <Button asChild variant="outline">
                    <Link href={`/reception/patients/new?familyOf=${family[0]!.id}`}>
                      <UserRoundPlus aria-hidden />
                      {t('addFamily')}
                    </Link>
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">{t('search.results', { count: rows.length })}</p>
            )}
            <ul
              id={listId}
              role="listbox"
              aria-label={t('search.list')}
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
                    'grid min-h-16 cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[2fr_1fr_1.5fr_auto]',
                    i === active && 'bg-accent outline-2 -outline-offset-2 outline-ring',
                    r.isDeceased && 'text-muted-foreground',
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold">
                      {r.fullName}
                      {r.isDeceased && (
                        <span className="ml-2 rounded-full border-2 border-border px-2 py-0.5 text-sm font-medium">
                          {t('search.deceased')}
                        </span>
                      )}
                    </p>
                    {r.nameHi && <p className="truncate text-muted-foreground">{r.nameHi}</p>}
                  </div>
                  <p className="text-lg tabular-nums">
                    {ageText(r.dob)} / {t(`sexShort.${r.sex as 'F' | 'M' | 'O'}`)}
                  </p>
                  <p className="hidden truncate md:block">
                    {[r.guardianName, r.localityName].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-right text-lg font-medium tabular-nums">
                    {r.uhid}
                    {r.mobile && (
                      <span className="block text-sm font-normal text-muted-foreground">
                        ••••{r.mobile.slice(-4)}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
