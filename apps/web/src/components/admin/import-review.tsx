'use client';

import {
  buildErrorReport,
  toCsv,
  type ImportKind,
  type ImportRowStatus,
  type RowIssue,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC, useTRPCClient } from '@/trpc/client';
import { baseName, saveBlob } from './import-files';
import { StatusChip } from './user-list';

type Filter = 'attention' | 'ok' | 'all';
const FILTER_STATUSES: Record<Filter, ImportRowStatus[] | undefined> = {
  attention: ['error', 'duplicate', 'failed'],
  ok: ['ok', 'committed', 'unchanged'],
  all: undefined,
};
const TONE = {
  ok: 'ok',
  committed: 'ok',
  unchanged: 'muted',
  error: 'danger',
  failed: 'danger',
  duplicate: 'warn',
} as const;

/** MIG-01 review screen: dry-run verdicts, column mapping, error report, batched commit. */
export function ImportReview({ batchId }: { batchId: string }) {
  const t = useTranslations('import');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const batch = useQuery(trpc.importer.get.queryOptions({ batchId }));
  const [filter, setFilter] = useState<Filter>('attention');
  const [limit, setLimit] = useState(50);
  const rows = useQuery(
    trpc.importer.rows.queryOptions({ batchId, statuses: FILTER_STATUSES[filter], limit }),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.importer.pathKey() });

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const b = batch.data;
  if (batch.isPending) return <div className="h-40 animate-pulse rounded-lg bg-muted" aria-busy />;
  if (!b) return <FormStatus error={error ?? errorText(batch.error)} />;

  const kind: ImportKind = b.kind;
  const count = (s: string) => b.counts[s] ?? 0;
  const editable = b.stage === 'dry_run';
  const toImport = b.pending;
  const issueText = (i: RowIssue) =>
    `${t(`fields.${i.field}` as 'fields.row')}: ${t(`issues.${i.code}` as 'issues.invalid')}`;

  async function downloadReport() {
    await guarded(async () => {
      const report = await client.importer.report.query({ batchId });
      const csv = toCsv(
        buildErrorReport(
          report.headers,
          report.rows.map((r) => ({ ...r, status: r.status as ImportRowStatus })),
          {
            row: t('review.rowNo'),
            status: t('review.status'),
            problems: t('review.problems'),
            statuses: Object.fromEntries(
              (['ok', 'error', 'duplicate', 'unchanged', 'committed', 'failed'] as const).map(
                (s) => [s, t(`status.${s}`)],
              ),
            ),
          },
          issueText,
        ),
      );
      saveBlob(
        new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        `${t('review.reportName', { name: baseName(report.fileName) })}.csv`,
      );
    });
  }

  async function commit() {
    await guarded(async () => {
      setProgress(count('committed'));
      for (;;) {
        const step = await client.importer.commitStep.mutate({ batchId });
        setProgress(step.counts.committed ?? 0);
        if (step.done) break;
      }
    });
    setProgress(null);
  }

  const setMapping = (index: number, target: string) => {
    const mapping = b.mapping.map((m, i) => (i === index ? target || null : m));
    void guarded(async () => {
      await client.importer.remap.mutate({ batchId, mapping });
    });
  };
  const setOptions = (options: Record<string, unknown>) =>
    guarded(async () => {
      await client.importer.remap.mutate({ batchId, options });
    });

  async function cancel() {
    await guarded(async () => {
      await client.importer.cancel.mutate({ batchId, reason });
      setCancelling(false);
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/import" className="text-sm underline">
          {t('review.back')}
        </Link>
        <h1 className="text-3xl font-semibold">{t('review.title')}</h1>
        <p className="text-lg">
          {b.fileName}{' '}
          <span className="text-muted-foreground">
            · {t(`kind.${kind}`)} · {t('rowsCount', { count: b.totalRows })} ·{' '}
            {t(`stage.${b.stage as 'dry_run' | 'committing' | 'committed' | 'cancelled'}`)}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap gap-2" aria-live="polite">
        {(['ok', 'error', 'duplicate', 'unchanged', 'committed', 'failed'] as const).map(
          (s) =>
            count(s) > 0 && (
              <StatusChip key={s} label={`${t(`status.${s}`)}: ${count(s)}`} tone={TONE[s]} />
            ),
        )}
      </div>
      <FormStatus
        error={error}
        success={
          b.stage === 'committed'
            ? t('review.done', {
                committed: count('committed'),
                unchanged: count('unchanged'),
                failed: count('failed'),
              })
            : b.stage === 'cancelled'
              ? t('review.cancelled')
              : null
        }
      />

      {(b.stage === 'dry_run' || b.stage === 'committing') && (
        <section className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-xl font-semibold">{t('review.mapping')}</h2>
          <p className="text-sm text-muted-foreground">
            {editable ? t('review.mappingHelp') : t('review.locked')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="py-2 pe-4">{t('review.column')}</th>
                  <th className="py-2">{t('review.holds')}</th>
                </tr>
              </thead>
              <tbody>
                {b.headers.map((h, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 pe-4 font-medium">{h || `#${i + 1}`}</td>
                    <td className="py-2">
                      <Select
                        aria-label={h || `#${i + 1}`}
                        value={b.mapping[i] ?? ''}
                        disabled={!editable || busy}
                        onChange={(e) => setMapping(i, e.target.value)}
                      >
                        <option value="">{t('review.ignore')}</option>
                        {b.targets.map((x) => (
                          <option key={x} value={x}>
                            {t(`fields.${x}` as 'fields.row')}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && kind === 'services_rates' && (
            <div className="max-w-xs space-y-2">
              <Label htmlFor="rv-date">{t('options.defaultEffectiveFrom')}</Label>
              <Input
                id="rv-date"
                type="date"
                defaultValue={b.options.defaultEffectiveFrom ?? ''}
                disabled={busy}
                onBlur={(e) => {
                  if ((e.target.value || null) !== b.options.defaultEffectiveFrom) {
                    void setOptions({ defaultEffectiveFrom: e.target.value || null });
                  }
                }}
              />
            </div>
          )}
          {editable && kind === 'patients' && (
            <div className="max-w-sm space-y-2">
              <Label htmlFor="rv-dups">{t('options.duplicates')}</Label>
              <Select
                id="rv-dups"
                value={b.options.duplicates}
                disabled={busy}
                onChange={(e) => void setOptions({ duplicates: e.target.value })}
              >
                <option value="skip">{t('options.duplicatesSkip')}</option>
                <option value="import">{t('options.duplicatesImport')}</option>
              </Select>
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" className="flex gap-2">
            {(['attention', 'ok', 'all'] as const).map((f) => (
              <Button
                key={f}
                role="tab"
                aria-selected={filter === f}
                variant={filter === f ? 'default' : 'outline'}
                onClick={() => {
                  setFilter(f);
                  setLimit(50);
                }}
              >
                {t(`review.filter.${f}`)}
              </Button>
            ))}
          </div>
          <div className="space-y-1 text-end">
            <Button
              variant="outline"
              onClick={() => void downloadReport()}
              disabled={busy || count('error') + count('duplicate') + count('failed') === 0}
            >
              <Download aria-hidden /> {t('review.report')}
            </Button>
            <p className="max-w-xs text-xs text-muted-foreground">{t('review.reportHelp')}</p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b text-sm text-muted-foreground">
                <th className="p-3">{t('review.rowNo')}</th>
                <th className="p-3">{t('review.status')}</th>
                <th className="p-3">{t('review.details')}</th>
                <th className="p-3">{t('review.problems')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.data?.map((r) => (
                <tr key={r.id} className="border-b align-top last:border-0">
                  <td className="p-3 tabular-nums">{r.sourceRow}</td>
                  <td className="p-3">
                    <StatusChip
                      label={t(`status.${r.status as ImportRowStatus}`)}
                      tone={TONE[r.status as ImportRowStatus]}
                    />
                  </td>
                  <td className="p-3">
                    <RowDetails kind={kind} preview={r.preview} raw={r.raw} />
                  </td>
                  <td className="p-3 text-sm">
                    {r.issues.map((i) => (
                      <p
                        key={`${i.field}-${i.code}`}
                        className={i.level === 'error' ? 'text-destructive' : undefined}
                      >
                        {issueText(i)}
                      </p>
                    ))}
                  </td>
                </tr>
              ))}
              {rows.data?.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-muted-foreground">
                    {t('review.noRows')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.data && rows.data.length >= limit && limit < 500 && (
          <Button variant="outline" onClick={() => setLimit((n) => Math.min(n + 100, 500))}>
            {t('review.showMore')}
          </Button>
        )}
      </section>

      {(b.stage === 'dry_run' || b.stage === 'committing') && (
        <section className="space-y-3 rounded-lg border-2 bg-card p-5">
          <p className="text-muted-foreground">{t('review.commitHelp')}</p>
          {progress !== null && (
            <p role="status" className="font-medium tabular-nums">
              {t('review.committing', { done: progress, total: toImport + count('committed') })}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => void commit()}
              disabled={busy || (toImport === 0 && b.stage === 'dry_run')}
            >
              {b.stage === 'committing'
                ? t('review.continue')
                : toImport > 0
                  ? t('review.commit', { count: toImport })
                  : t('review.commitNone')}
            </Button>
            {editable && !cancelling && (
              <Button variant="outline" onClick={() => setCancelling(true)} disabled={busy}>
                {t('review.cancel')}
              </Button>
            )}
          </div>
          {cancelling && (
            <div className="max-w-md space-y-2">
              <Label htmlFor="rv-reason">{t('review.cancelReason')}</Label>
              <Input id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button
                variant="destructive"
                onClick={() => void cancel()}
                disabled={busy || reason.trim().length < 3}
              >
                {t('review.cancelConfirm')}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function RowDetails({
  kind,
  preview,
  raw,
}: {
  kind: ImportKind;
  preview: Record<string, string>;
  raw: string[];
}) {
  const t = useTranslations('import.review');
  // A row that failed validation has no preview: show what was read from the file.
  if (Object.keys(preview).length === 0) {
    return <span className="text-sm text-muted-foreground">{raw.filter(Boolean).join(' · ')}</span>;
  }
  if (kind === 'patients') {
    return (
      <div className="text-sm">
        <p className="font-medium">{preview.name}</p>
        <p className="text-muted-foreground tabular-nums">
          {[preview.sex, preview.mobile, preview.dob, preview.oldUhid].filter(Boolean).join(' · ')}
        </p>
        {preview.matchUhid && (
          <p className="text-muted-foreground">
            {t('matchesPatient', { uhid: preview.matchUhid, name: preview.matchName ?? '' })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="text-sm">
      <p className="font-medium">
        {preview.code} · {preview.name}
      </p>
      <p className="text-muted-foreground tabular-nums">
        {preview.tariff} · {preview.from} · {preview.rate}
        {preview.oldRate ? ` (${t('previewOldRate', { rate: preview.oldRate })})` : ''}
        {preview.service === 'new' ? ` · ${t('previewServiceNew')}` : ''}
      </p>
    </div>
  );
}
