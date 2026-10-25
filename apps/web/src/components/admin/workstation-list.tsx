'use client';

import { formatDateTime } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus, TextField } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { StatusChip } from './user-list';

/** Workstations and device pairing (docs/01 §4–5). */
export function WorkstationList() {
  const t = useTranslations('admin.workstations');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const list = useQuery(trpc.admin.listWorkstations.queryOptions());
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: trpc.admin.listWorkstations.queryKey() });
    // Header shows the paired workstation name (server-rendered).
    router.refresh();
  };
  const onError = (e: unknown) => setError(errorText(e));
  const create = useMutation(
    trpc.admin.createWorkstation.mutationOptions({
      onSuccess: () => {
        setName('');
        setLocation('');
        refresh();
      },
      onError,
    }),
  );
  const pair = useMutation(
    trpc.admin.pairWorkstation.mutationOptions({ onSuccess: refresh, onError }),
  );
  const unpairHere = useMutation(
    trpc.admin.unpairThisDevice.mutationOptions({ onSuccess: refresh, onError }),
  );
  const unpairAll = useMutation(
    trpc.admin.unpairWorkstation.mutationOptions({ onSuccess: refresh, onError }),
  );
  const update = useMutation(
    trpc.admin.updateWorkstation.mutationOptions({ onSuccess: refresh, onError }),
  );
  const rows = list.data ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('help')}</p>
      </div>
      <FormStatus error={error} />
      {list.isPending ? (
        <div className="h-24 animate-pulse rounded-lg bg-muted" aria-busy="true" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-lg">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {rows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="space-y-1">
                <p className="text-lg font-semibold">
                  {w.name}{' '}
                  {w.location && (
                    <span className="font-normal text-muted-foreground">· {w.location}</span>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  {w.isThisDevice && <StatusChip label={t('thisDevice')} tone="ok" />}
                  {!w.isActive && <StatusChip label={t('inactive')} tone="muted" />}
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {w.pairedAt ? `${t('paired')}: ${formatDateTime(w.pairedAt)}` : t('notPaired')}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {w.isThisDevice ? (
                  <Button variant="outline" onClick={() => unpairHere.mutate()}>
                    {t('unpairHere')}
                  </Button>
                ) : (
                  <Button
                    disabled={!w.isActive}
                    onClick={() => pair.mutate({ workstationId: w.id })}
                  >
                    {t('pair')}
                  </Button>
                )}
                {w.pairedAt && (
                  <Button
                    variant="outline"
                    onClick={() => unpairAll.mutate({ workstationId: w.id })}
                  >
                    {t('unpairAll')}
                  </Button>
                )}
                <Button
                  variant={w.isActive ? 'ghost' : 'outline'}
                  onClick={() =>
                    update.mutate({
                      workstationId: w.id,
                      name: w.name,
                      location: w.location ?? undefined,
                      isActive: !w.isActive,
                    })
                  }
                >
                  {w.isActive ? t('deactivate') : t('activate')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid max-w-3xl gap-4 rounded-lg border bg-card p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ name, location });
        }}
      >
        <TextField label={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          label={t('location')}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <Button type="submit" disabled={create.isPending || name.trim().length < 2}>
          {t('add')}
        </Button>
      </form>
    </div>
  );
}
