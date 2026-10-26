'use client';

import { type QueuePriority } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { cn } from '@hmis/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { HeartPulse, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAgeText } from '@/lib/use-age-text';
import { useLiveQueue } from '@/lib/use-live-queue';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';

type Desk = inferRouterOutputs<AppRouter>['vitals']['desk'];
type Item = Desk['waiting'][number];

/**
 * Vitals desk list (OPD-01, docs/11 §1): patients waiting for vitals, priority first then oldest,
 * with the ones measured today below for corrections. One tap opens the form. Live over SSE like
 * the queue (polling when there is no stream).
 */
export function VitalsDesk() {
  const t = useTranslations('vitals');
  const tQ = useTranslations('queue');
  const ageText = useAgeText();
  const locale = useLocale();
  const trpc = useTRPC();
  const { refetchInterval } = useLiveQueue();
  const desk = useQuery(trpc.vitals.desk.queryOptions(undefined, { refetchInterval }));

  const doctorName = (d: Item['doctor']) =>
    locale === 'hi' && d.displayNameHi ? d.displayNameHi : d.displayName;
  const urgent = (p: QueuePriority) => p !== 'normal';

  const row = (i: Item, done: boolean) => (
    <li
      key={i.tokenId}
      data-state={i.queueState}
      data-token={i.tokenNo}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border-2 bg-card p-4"
    >
      <p className="w-20 text-3xl font-semibold tabular-nums">{i.tokenNo}</p>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold">
          {locale === 'hi' && i.nameHi ? i.nameHi : i.fullName}
        </p>
        <p className="text-muted-foreground">
          {ageText(i.dob)} / {tQ(`sex.${i.sex as 'F' | 'M' | 'O'}`)} · {i.uhid} ·{' '}
          {doctorName(i.doctor)}
        </p>
      </div>
      {urgent(i.priority) && (
        <span className="rounded-full border-2 border-destructive px-3 py-1 text-sm font-semibold text-destructive">
          {tQ(`priorities.${i.priority}`)}
        </span>
      )}
      {i.flags.some((f) => f.level !== 'alert') && (
        <span className="rounded-full border-2 border-amber-600 bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-950">
          ▲ {t('outOfRange')}
        </span>
      )}
      <Button asChild variant={done ? 'outline' : 'default'} size="lg">
        <Link href={`/nursing/vitals/${i.tokenId}`}>
          {done ? <Pencil aria-hidden /> : <HeartPulse aria-hidden />}
          {done ? t('edit') : t('enter')}
        </Link>
      </Button>
    </li>
  );

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('deskTitle')}</h1>
        <p className="text-lg text-muted-foreground">{t('deskHint')}</p>
      </div>

      {desk.isError && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('loadFailed')}
        </p>
      )}

      <section aria-labelledby="vitals-waiting" className="space-y-3">
        <h2 id="vitals-waiting" className="text-2xl font-semibold">
          {t('waitingTitle')}
          {desk.data && (
            <span className="ml-2 text-muted-foreground">({desk.data.waiting.length})</span>
          )}
        </h2>
        {desk.data && desk.data.waiting.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
            {t('nobodyWaiting')}
          </p>
        ) : (
          <ul className="space-y-3" data-testid="vitals-waiting">
            {desk.data?.waiting.map((i) => row(i, false))}
          </ul>
        )}
      </section>

      {desk.data && desk.data.done.length > 0 && (
        <section aria-labelledby="vitals-done" className={cn('space-y-3')}>
          <h2 id="vitals-done" className="text-2xl font-semibold">
            {t('doneTitle')}
          </h2>
          <ul className="space-y-3" data-testid="vitals-done">
            {desk.data.done.map((i) => row(i, true))}
          </ul>
        </section>
      )}
    </div>
  );
}
