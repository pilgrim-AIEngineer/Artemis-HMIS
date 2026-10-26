'use client';

import { formatDate, GROWTH_LIMITS, type GrowthIndicator } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { GrowthChart } from '@hmis/ui/components/growth-chart';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { numOrNull, Section, today } from '@/components/anc/anc-common';
import { FormStatus } from '@/components/form/text-field';
import { PrintButton } from '@/components/print/print-button';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { key, type GrowthOverview } from './paeds-common';

type Measurement = GrowthOverview['measurements'][number];
const INDICATORS: readonly GrowthIndicator[] = ['wfa', 'lhfa', 'hcfa', 'wfh'];

const BAND_TONE: Record<string, string> = {
  lt_neg3: 'border-destructive bg-red-50 text-red-950',
  lt_neg2: 'border-amber-600 bg-amber-50 text-amber-950',
  gt_pos2: 'border-amber-600 bg-amber-50 text-amber-950',
  gt_pos3: 'border-destructive bg-red-50 text-red-950',
};

function Z({ m, k }: { m: Measurement; k: GrowthIndicator }) {
  const t = useTranslations('paeds');
  const z = m.zScores[k];
  if (z === null || z === undefined) return <span>—</span>;
  const band = m.bands[k];
  const bad = band && band !== 'normal';
  return (
    <span
      data-testid={`paeds-z-${k}`}
      className={cn(
        'inline-block rounded-md border-2 px-2 py-0.5 tabular-nums',
        bad ? (BAND_TONE[band] ?? '') : 'border-transparent',
      )}
    >
      {bad ? '▲ ' : ''}
      {z > 0 ? '+' : ''}
      {z.toFixed(2)}
      {bad && <span className="ml-1 text-sm font-semibold">{key(t)(`band.${band}`)}</span>}
    </span>
  );
}

/**
 * Growth (docs/11 §4.2): enter weight, length / height and head circumference; WHO z-scores are
 * worked out on save and the child's points are drawn on the four WHO charts. From 5 years only the
 * values are kept (the IAP charts are not bundled yet). The vitals desk fills the same table for
 * children.
 */
export function GrowthSection({ growth, canEdit }: { growth: GrowthOverview; canEdit: boolean }) {
  const t = useTranslations('paeds');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [measuredOn, setMeasuredOn] = useState(today());
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [head, setHead] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [idem, setIdem] = useState(uuidv7);
  const refresh = () => void qc.invalidateQueries({ queryKey: [['paeds']] });

  const save = useMutation(
    trpc.paeds.recordGrowth.mutationOptions({
      onSuccess: () => {
        setError(null);
        setWeight('');
        setHeight('');
        setHead('');
        setIdem(uuidv7());
        refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const cancel = useMutation(
    trpc.paeds.cancelGrowth.mutationOptions({
      onSuccess: () => {
        setCancelling(null);
        setReason('');
        setError(null);
        refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const empty = [weight, height, head].every((v) => v.trim() === '');
  const num = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    unit: string,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label} ({unit})
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        className="w-32"
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );

  return (
    <Section
      id="paeds-growth"
      title={t('growth.title')}
      aside={
        <PrintButton
          template="growth-chart"
          entityId={growth.patient.id}
          label={t('print.growth')}
          variant="outline"
          shortcut={false}
        />
      }
    >
      {canEdit && (
        <form
          className="space-y-3 rounded-lg border-2 border-dashed p-3"
          aria-label={t('growth.add')}
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate({
              idempotencyKey: idem,
              patientId: growth.patient.id,
              encounterId: null,
              measuredOn,
              weightKg: numOrNull(weight),
              lengthHeightCm: numOrNull(height),
              headCircCm: numOrNull(head),
            });
          }}
        >
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="growth-date">{t('growth.measuredOn')}</Label>
              <Input
                id="growth-date"
                type="date"
                max={today()}
                min={growth.patient.dob}
                value={measuredOn}
                onChange={(e) => setMeasuredOn(e.target.value)}
              />
            </div>
            {num('growth-weight', t('growth.weight'), weight, setWeight, 'kg')}
            {num('growth-height', t('growth.lengthHeight'), height, setHeight, 'cm')}
            {num('growth-head', t('growth.head'), head, setHead, 'cm')}
            <Button type="submit" size="lg" disabled={empty || save.isPending}>
              <Save aria-hidden />
              {t('growth.save')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('growth.limits', {
              w: `${GROWTH_LIMITS.weightKg.min}–${GROWTH_LIMITS.weightKg.max}`,
              h: `${GROWTH_LIMITS.lengthHeightCm.min}–${GROWTH_LIMITS.lengthHeightCm.max}`,
            })}
          </p>
        </form>
      )}
      <FormStatus error={error} />

      {growth.measurements.length === 0 ? (
        <p className="text-muted-foreground" data-testid="paeds-growth-empty">
          {t('growth.none')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[44rem] border-collapse text-base"
            data-testid="paeds-growth-table"
          >
            <thead>
              <tr className="border-b-2 text-left">
                {(['date', 'weight', 'lengthHeight', 'head'] as const).map((c) => (
                  <th key={c} scope="col" className="px-2 py-2 font-semibold">
                    {t(`growth.col.${c}`)}
                  </th>
                ))}
                {INDICATORS.map((k) => (
                  <th key={k} scope="col" className="px-2 py-2 font-semibold">
                    {t(`growth.z.${k}`)}
                  </th>
                ))}
                {canEdit && <th scope="col" className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {growth.measurements.map((m) => (
                <tr key={m.id} className="border-b" data-date={m.measuredOn}>
                  <td className="px-2 py-2">{formatDate(m.measuredOn)}</td>
                  <td className="px-2 py-2 tabular-nums">{m.weightKg ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums">{m.lengthHeightCm ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums">{m.headCircCm ?? '—'}</td>
                  {INDICATORS.map((k) => (
                    <td key={k} className="px-2 py-2">
                      <Z m={m} k={k} />
                    </td>
                  ))}
                  {canEdit && (
                    <td className="px-2 py-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setCancelling(m.id)}
                        aria-label={t('growth.cancelFor', { date: formatDate(m.measuredOn) })}
                      >
                        <X aria-hidden />
                        {t('given.cancel')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {growth.measurements.some((m) => m.zScores.implausible.length > 0) && (
        <p role="note" className="font-medium text-amber-900">
          ▲ {t('growth.implausible')}
        </p>
      )}
      {cancelling && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border-2 border-dashed p-3"
          onSubmit={(e) => {
            e.preventDefault();
            cancel.mutate({ id: cancelling, reason });
          }}
        >
          <div className="min-w-64 flex-1 space-y-1">
            <Label htmlFor="growth-cancel-reason">{t('given.reason')}</Label>
            <Input
              id="growth-cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
          <Button type="submit" disabled={reason.trim().length < 3 || cancel.isPending}>
            {t('given.cancelConfirm')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setCancelling(null)}>
            {t('dialog.cancel')}
          </Button>
        </form>
      )}

      {growth.charts ? (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="paeds-charts">
          {growth.charts.map((c) => (
            <GrowthChart
              key={c.indicator}
              indicator={c.indicator}
              curve={c.curve}
              points={c.points}
              title={key(t)(`growth.chart.${c.indicator}`)}
              xLabel={c.indicator === 'wfh' ? t('growth.axisLength') : t('growth.axisAge')}
              yLabel=""
              units={{ year: t('growth.unitYear'), month: t('growth.unitMonth') }}
              className="w-full"
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground" data-testid="paeds-values-only">
          {growth.chartsSkipped === 'sex' ? t('growth.valuesOnlySex') : t('growth.valuesOnlyAge')}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t('growth.note')}</p>
    </Section>
  );
}
