'use client';

import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import { Baby, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatDate } from '@hmis/shared';
import { useAgeText } from '@/lib/use-age-text';
import { useDebounced } from '@/lib/use-debounced';
import { useTRPC } from '@/trpc/client';
import { RiskChips, SignOffBanner } from './anc-common';

/**
 * ANC desk (OPD-05): find a woman by name, mobile or UHID and open her ANC card, or pick one of
 * the active pregnancies (soonest EDD first). Keyboard: type, ↑/↓, Enter.
 */
export function AncDesk() {
  const t = useTranslations('anc');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const ageText = useAgeText();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 150);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const list = useQuery(trpc.anc.active.queryOptions());
  const rules = useQuery(trpc.anc.rules.queryOptions());
  const search = useQuery(
    trpc.patients.search.queryOptions(debounced ? { q: debounced } : skipToken, {
      placeholderData: keepPreviousData,
    }),
  );
  const rows = debounced ? (search.data?.rows ?? []).filter((r) => r.sex !== 'M') : [];
  const open = (patientId: string) => router.push(`/assistant/anc/${patientId}`);
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
        <label htmlFor="anc-search" className="text-lg font-medium">
          {t('search')}
        </label>
        <div className="relative">
          <Search
            aria-hidden
            className="absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="anc-search"
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
          <ul className="space-y-2" data-testid="anc-search-results">
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

      <section aria-labelledby="anc-active" className="space-y-3">
        <h2 id="anc-active" className="text-2xl font-semibold">
          {t('activeTitle')}
          {list.data && <span className="ml-2 text-muted-foreground">({list.data.length})</span>}
        </h2>
        {list.isError && (
          <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
            {t('loadFailed')}
          </p>
        )}
        {list.data && list.data.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
            {t('nobodyActive')}
          </p>
        ) : (
          <ul className="space-y-3" data-testid="anc-active-list">
            {list.data?.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border-2 bg-card p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-xl font-semibold">
                    {locale === 'hi' && p.nameHi ? p.nameHi : p.fullName}
                  </p>
                  <p className="text-muted-foreground">
                    {p.uhid} · {t('ga')} {p.gaLabel} · {t('edd')} {formatDate(p.eddFinal)} ·{' '}
                    {p.gpalText}
                  </p>
                  <RiskChips risks={p.risks} />
                  {p.nextVisit && (
                    <p className={p.nextVisit.overdue ? 'font-semibold text-destructive' : ''}>
                      {t('nextVisit')}: {formatDate(p.nextVisit.date)}
                      {p.nextVisit.overdue ? ` · ${t('state.overdue')}` : ''}
                    </p>
                  )}
                </div>
                <Button asChild size="lg" variant="outline">
                  <Link href={`/assistant/anc/${p.patientId}`}>
                    <Baby aria-hidden />
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
