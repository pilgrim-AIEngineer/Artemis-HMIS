'use client';

import {
  formatDate,
  formatDateTime,
  formatINR,
  TIMELINE_ITEM_TYPES,
  type TimelineItemType,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { PatientHeader } from '@hmis/ui/components/patient-header';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAgeText } from '@/lib/use-age-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';

type Item = inferRouterOutputs<AppRouter>['timeline']['list']['items'][number];
type T = ReturnType<typeof useTranslations<'timeline'>>;

/** Looks up a catalogue key built at run time (closed sets, all in the catalogue). */
const key = (t: T) => t as unknown as (k: string, v?: Record<string, string | number>) => string;

const PAGE = 20;

/**
 * Patient timeline (OPD-07, docs/11 §2.8): newest first, one card per visit, prescription, order,
 * bill, ANC visit, vaccine or document, 20 at a time with a "Show older" button. The server
 * leaves out what the user may not see and every restricted record; the filter chips only offer
 * the kinds the server says are visible.
 */
export function PatientTimeline({ patientId }: { patientId: string }) {
  const t = useTranslations('timeline');
  const ageText = useAgeText();
  const trpc = useTRPC();
  const [only, setOnly] = useState<TimelineItemType | null>(null);

  const patient = useQuery(trpc.patients.get.queryOptions({ id: patientId }));
  const visible = useQuery(trpc.timeline.types.queryOptions());
  const base = trpc.timeline.list.infiniteQueryOptions(
    { patientId, limit: PAGE, ...(only ? { types: [only] } : {}) },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const list = useInfiniteQuery(base);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const p = patient.data;

  return (
    <div className="space-y-5">
      {p && (
        <PatientHeader
          name={p.fullName}
          nameHi={p.nameHi}
          ageSex={ageText(p.dob)}
          uhid={p.uhid}
          mobileLast4={p.mobile?.slice(-4)}
          mobileLabel=""
          flags={[]}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <Button asChild variant="outline">
          <Link href={`/reception/patients/${patientId}`}>{t('back')}</Link>
        </Button>
      </div>

      <div role="group" aria-label={t('filters')} className="flex flex-wrap gap-2">
        {[null, ...TIMELINE_ITEM_TYPES.filter((x) => visible.data?.includes(x))].map((x) => (
          <Button
            key={x ?? 'all'}
            type="button"
            variant={only === x ? 'default' : 'outline'}
            aria-pressed={only === x}
            className="min-h-11"
            onClick={() => setOnly(x)}
          >
            {x ? key(t)(`types.${x}`) : t('all')}
          </Button>
        ))}
      </div>

      {list.isError ? (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('loadFailed')}
        </p>
      ) : list.isPending ? (
        <p className="text-lg text-muted-foreground">{t('loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-lg text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="space-y-3" data-testid="timeline-list">
          {items.map((item) => (
            <li
              key={item.key}
              data-type={item.type}
              className="rounded-lg border bg-card p-4 text-card-foreground"
            >
              <ItemCard item={item} />
            </li>
          ))}
        </ol>
      )}

      {list.hasNextPage && (
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
        </Button>
      )}
    </div>
  );
}

function Row({
  type,
  at,
  date,
  children,
}: {
  type: string;
  at: string;
  date?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations('timeline');
  const when = new Date(at);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{key(t)(`types.${type}`)}</span>
        <time dateTime={at} className="text-sm text-muted-foreground tabular-nums">
          {date ? formatDate(when) : formatDateTime(when)}
        </time>
      </div>
      {children}
    </div>
  );
}

function ItemCard({ item }: { item: Item }) {
  const t = useTranslations('timeline');
  const k = key(t);
  switch (item.type) {
    case 'visit': {
      const v = item.vitals;
      const parts = v
        ? [
            v.bpSys !== null && v.bpDia !== null
              ? t('visit.bp', { sys: v.bpSys, dia: v.bpDia })
              : null,
            v.pulse !== null ? t('visit.pulse', { value: v.pulse }) : null,
            v.tempC !== null ? t('visit.temp', { value: v.tempC }) : null,
            v.spo2 !== null ? t('visit.spo2', { value: v.spo2 }) : null,
            v.weightKg !== null ? t('visit.weight', { value: v.weightKg }) : null,
          ].filter(Boolean)
        : [];
      return (
        <Row type="visit" at={item.at}>
          <p className="text-lg font-semibold">
            {t('visit.title', { number: item.number })} · {k(`visitType.${item.visitType}`)}
          </p>
          <p>
            {t('visit.doctor', { name: item.doctorName })}
            {item.status !== 'closed' && ` · ${k(`visitStatus.${item.status}`)}`}
          </p>
          <p className="text-muted-foreground">
            {parts.length > 0 ? parts.join(' · ') : t('visit.noVitals')}
          </p>
        </Row>
      );
    }
    case 'rx':
      return (
        <Row type="rx" at={item.at}>
          <p className="text-lg font-semibold">
            {t('visit.doctor', { name: item.doctorName })}
            {item.version > 1 && ` · ${t('rx.version', { version: item.version })}`}
            {item.verified && ` · ${t('rx.verified')}`}
          </p>
          {item.items.length === 0 ? (
            <p className="text-muted-foreground">{t('rx.noItems')}</p>
          ) : (
            <ul className="list-disc pl-5">
              {item.items.map((r, i) => (
                <li key={i}>
                  {[r.drugName, r.doseText, r.pattern, duration(t, r.durationValue, r.durationUnit)]
                    .filter(Boolean)
                    .join(' · ')}
                </li>
              ))}
            </ul>
          )}
        </Row>
      );
    case 'order':
      return (
        <Row type="order" at={item.at}>
          <p className="text-lg font-semibold">{item.name ?? k(`orderKind.${item.kind}`)}</p>
          <p className="text-muted-foreground">
            {k(`orderKind.${item.kind}`)} · {k(`orderStatus.${item.status}`)}
          </p>
        </Row>
      );
    case 'bill':
      return (
        <Row type="bill" at={item.at}>
          <p className="text-lg font-semibold">
            {t('bill.title', { number: item.number ?? '' })} · {k(`billStatus.${item.status}`)}
          </p>
          <p className="tabular-nums">
            {t('bill.net', { amount: formatINR(item.netPaise) })} ·{' '}
            {t('bill.paid', { amount: formatINR(item.paidPaise) })}
            {item.balancePaise > 0n &&
              ` · ${t('bill.balance', { amount: formatINR(item.balancePaise) })}`}
          </p>
        </Row>
      );
    case 'anc': {
      const weeks = Math.floor(item.gaDays / 7);
      return (
        <Row type="anc" at={item.at} date>
          <p className="text-lg font-semibold">
            {t('anc.title')} · {t('anc.ga', { weeks, days: item.gaDays % 7 })}
          </p>
          <p className="text-muted-foreground tabular-nums">
            {[
              item.bpSys !== null && item.bpDia !== null
                ? t('visit.bp', { sys: item.bpSys, dia: item.bpDia })
                : null,
              item.weightKg !== null ? t('anc.weight', { value: item.weightKg }) : null,
              item.hb !== null ? t('anc.hb', { value: item.hb }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </Row>
      );
    }
    case 'vaccine':
      return (
        <Row type="vaccine" at={item.at} date>
          <p className="text-lg font-semibold">{t('vaccine.title', { name: item.vaccineName })}</p>
          <p className="text-muted-foreground">{t('vaccine.batch', { batch: item.batchNo })}</p>
        </Row>
      );
    case 'document':
      return (
        <Row type="document" at={item.at}>
          <p className="text-lg font-semibold">{k(`documentKind.${item.kind}`)}</p>
          {item.kind === 'rx_scan' && (
            <Button asChild variant="outline" className="mt-1 min-h-11">
              <a href={`/api/documents/rx-scan/${item.id}`} target="_blank" rel="noreferrer">
                {t('document.view')}
              </a>
            </Button>
          )}
        </Row>
      );
  }
}

function duration(t: T, value: number | null, unit: string | null): string | null {
  if (value === null || !unit) return null;
  const k = unit === 'd' ? 'days' : unit === 'w' ? 'weeks' : 'months';
  return key(t)(`rx.${k}`, { value });
}
