'use client';

import { Button } from '@hmis/ui/components/button';
import { cn } from '@hmis/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTRPC } from '@/trpc/client';

type State = 'ok' | 'down' | 'pending';

function StatusRow({ label, state, text }: { label: string; state: State; text: string }) {
  const Icon = state === 'ok' ? CircleCheck : state === 'down' ? CircleX : LoaderCircle;
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        data-state={state}
        className={cn(
          'flex items-center gap-2 font-medium',
          state === 'ok' && 'text-money',
          state === 'down' && 'text-destructive',
        )}
      >
        <Icon aria-hidden className={cn('size-5', state === 'pending' && 'animate-spin')} />
        {text}
      </dd>
    </div>
  );
}

export function StatusPanel() {
  const t = useTranslations('status');
  const trpc = useTRPC();
  const health = useQuery(trpc.health.check.queryOptions(undefined, { refetchInterval: 30_000 }));

  const server: State = health.isPending ? 'pending' : health.isError ? 'down' : 'ok';
  const db: State = health.isPending ? 'pending' : health.data?.checks.db.ok ? 'ok' : 'down';
  const label = (s: State, ok: 'running' | 'connected') =>
    s === 'pending' ? t('checking') : s === 'ok' ? t(ok) : t('unreachable');

  return (
    <section
      aria-labelledby="status-title"
      className="rounded-lg border bg-card p-6 text-card-foreground"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="status-title" className="text-xl font-semibold">
          {t('title')}
        </h2>
        <Button
          variant="outline"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
        >
          <RefreshCw aria-hidden />
          {t('refresh')}
        </Button>
      </div>
      <dl className="mt-2 divide-y" aria-live="polite">
        <StatusRow label={t('server')} state={server} text={label(server, 'running')} />
        <StatusRow label={t('database')} state={db} text={label(db, 'connected')} />
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t('version')}</dt>
          <dd className="font-mono">{health.data?.version ?? '—'}</dd>
        </div>
      </dl>
    </section>
  );
}
