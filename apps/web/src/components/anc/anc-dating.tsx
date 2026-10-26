'use client';

import { formatDate } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { useMutation, useQuery, useQueryClient, skipToken } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { numOrNull, Section, today, type PregnancyView } from './anc-common';

/**
 * Dating by scan (docs/11 §3.1): the scan date and the GA found are compared with the LMP using the
 * threshold table. The screen only suggests; a person picks "use scan EDD" or "keep LMP EDD", and the
 * change of `edd_final` is audited. Everything shown comes from the server's calculation.
 */
export function DatingSection({ v, canEdit }: { v: PregnancyView; canEdit: boolean }) {
  const t = useTranslations('anc');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const d = v.dating;
  const [scanDate, setScanDate] = useState(d.scanDate ?? '');
  const [weeks, setWeeks] = useState(
    d.scanGaDays === null ? '' : String(Math.floor(d.scanGaDays / 7)),
  );
  const [days, setDays] = useState(d.scanGaDays === null ? '0' : String(d.scanGaDays % 7));
  const [error, setError] = useState<string | null>(null);

  const w = numOrNull(weeks);
  const dd = numOrNull(days) ?? 0;
  const ready = !!scanDate && w !== null && w >= 5 && w <= 42 && dd >= 0 && dd <= 6;
  const assess = useQuery(
    trpc.anc.assessScan.queryOptions(
      ready ? { pregnancyId: v.id, scanDate, ga: { weeks: w, days: dd } } : skipToken,
    ),
  );
  const decide = useMutation(
    trpc.anc.confirmDating.mutationOptions({
      onSuccess: () => {
        setError(null);
        void qc.invalidateQueries({ queryKey: [['anc']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const a = assess.data?.assessment ?? null;
  const confirm = (basis: 'lmp' | 'scan') =>
    decide.mutate({ pregnancyId: v.id, basis, scanDate, ga: { weeks: w ?? 0, days: dd } });

  return (
    <Section id="anc-dating" title={t('dating.title')}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
        <Item label={t('lmp')} value={d.lmp ? formatDate(d.lmp) : t('create.lmpUnknown')} />
        <Item label={t('dating.eddByLmp')} value={d.eddByLmp ? formatDate(d.eddByLmp) : '—'} />
        <Item label={t('dating.eddByScan')} value={d.eddByScan ? formatDate(d.eddByScan) : '—'} />
        <Item
          label={t('edd')}
          value={`${formatDate(d.eddFinal)} (${t(`dating.basis.${d.basis}`)})`}
          strong
        />
      </dl>

      {d.redatingPending && (
        <p
          role="alert"
          data-testid="anc-redating-pending"
          className="rounded-lg border-2 border-amber-600 bg-amber-50 p-3 text-lg font-semibold text-amber-950"
        >
          ▲ {t('dating.pending')}
        </p>
      )}
      {d.decision && (
        <p className="text-muted-foreground" data-testid="anc-redating-decision">
          {t(`dating.decision.${d.decision}`)}
        </p>
      )}

      {canEdit && (
        <form
          className="space-y-3"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t('dating.scanForm')}
        >
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="anc-d-date">{t('scanDate')}</Label>
              <Input
                id="anc-d-date"
                type="date"
                max={today()}
                value={scanDate}
                onChange={(e) => setScanDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-d-weeks">{t('scanWeeks')}</Label>
              <Input
                id="anc-d-weeks"
                inputMode="numeric"
                className="w-28"
                value={weeks}
                onChange={(e) => setWeeks(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-d-days">{t('scanDays')}</Label>
              <Input
                id="anc-d-days"
                inputMode="numeric"
                className="w-28"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          </div>

          {ready && assess.data && (
            <div
              data-testid="anc-redating-assessment"
              className="space-y-2 rounded-lg border-2 bg-muted p-3"
            >
              <p>
                {t('dating.eddByScan')}: <strong>{formatDate(assess.data.eddByScan)}</strong>
              </p>
              {a ? (
                <>
                  <p>
                    {t('dating.difference', {
                      days: Math.abs(a.differenceDays),
                      limit: a.thresholdDays,
                    })}
                  </p>
                  <p className="text-lg font-semibold" data-testid="anc-redating-suggestion">
                    {a.suggestScan ? t('dating.suggestScan') : t('dating.suggestLmp')}
                  </p>
                </>
              ) : (
                <p>{t('dating.noLmp')}</p>
              )}
              <div className="flex flex-wrap gap-3">
                {a && (
                  <Button
                    type="button"
                    variant={a.suggestScan ? 'outline' : 'default'}
                    disabled={decide.isPending}
                    onClick={() => confirm('lmp')}
                  >
                    {t('dating.keepLmp')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant={!a || a.suggestScan ? 'default' : 'outline'}
                  disabled={decide.isPending}
                  onClick={() => confirm('scan')}
                >
                  {t('dating.useScan')}
                </Button>
              </div>
            </div>
          )}
          {assess.isError && <FormStatus error={errorText(assess.error)} />}
          <FormStatus error={error} />
        </form>
      )}
    </Section>
  );
}

function Item({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={strong ? 'text-lg font-semibold' : 'text-lg'}>{value}</dd>
    </div>
  );
}
