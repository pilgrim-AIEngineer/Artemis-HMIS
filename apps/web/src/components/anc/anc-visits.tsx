'use client';

import { formatDate, GRADE_SYMBOL, PRESENTATIONS } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { numOrNull, Section, today, type PregnancyView } from './anc-common';

type Visit = PregnancyView['visits'][number];

const DIPSTICK = ['nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4'] as const;
const OEDEMA = ['none', 'plus1', 'plus2'] as const;

interface Draft {
  visitDate: string;
  weightKg: string;
  bpSys: string;
  bpDia: string;
  fundalHeightCm: string;
  fhr: string;
  presentation: string;
  oedema: string;
  urineProtein: string;
  urineSugar: string;
  hb: string;
  remarks: string;
}

const blank = (): Draft => ({
  visitDate: today(),
  weightKg: '',
  bpSys: '',
  bpDia: '',
  fundalHeightCm: '',
  fhr: '',
  presentation: '',
  oedema: '',
  urineProtein: '',
  urineSugar: '',
  hb: '',
  remarks: '',
});

const fromVisit = (v: Visit): Draft => ({
  visitDate: v.visitDate,
  weightKg: v.weightKg === null ? '' : String(v.weightKg),
  bpSys: v.bpSys === null ? '' : String(v.bpSys),
  bpDia: v.bpDia === null ? '' : String(v.bpDia),
  fundalHeightCm: v.fundalHeightCm === null ? '' : String(v.fundalHeightCm),
  fhr: v.fhr === null ? '' : String(v.fhr),
  presentation: v.presentation ?? '',
  oedema: v.oedema ?? '',
  urineProtein: v.urineProtein ?? '',
  urineSugar: v.urineSugar ?? '',
  hb: v.hb === null ? '' : String(v.hb),
  remarks: v.remarks ?? '',
});

/** Weight against GA as a small SVG line (docs/11 §3.3), with the numbers as its text alternative. */
function WeightSparkline({ series }: { series: PregnancyView['weightSeries'] }) {
  const t = useTranslations('anc');
  if (series.length < 2) return null;
  const w = 220;
  const h = 48;
  const xs = series.map((p) => p.gaDays);
  const ys = series.map((p) => p.weightKg);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const px = (x: number) => 4 + ((x - x0) / Math.max(1, x1 - x0)) * (w - 8);
  const py = (y: number) => h - 4 - ((y - y0) / Math.max(0.1, y1 - y0)) * (h - 8);
  const gain = (ys[ys.length - 1]! - ys[0]!).toFixed(1);
  return (
    <figure className="flex items-center gap-3" data-testid="anc-weight-chart">
      <svg
        width={w}
        height={h}
        role="img"
        aria-label={t('weightChart', { gain, first: ys[0]!, last: ys[ys.length - 1]! })}
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          points={series.map((p) => `${px(p.gaDays)},${py(p.weightKg)}`).join(' ')}
        />
        {series.map((p) => (
          <circle key={p.date} cx={px(p.gaDays)} cy={py(p.weightKg)} r="3" fill="currentColor" />
        ))}
      </svg>
      <figcaption className="text-sm text-muted-foreground">{t('weightGain', { gain })}</figcaption>
    </figure>
  );
}

/**
 * ANC visit table and entry (docs/11 §3.3). Vitals taken at the vitals desk are already in the day's
 * row; the assistant opens it ("Edit") and adds presentation, Hb and remarks. One row per date.
 */
export function VisitsSection({ v, canEdit }: { v: PregnancyView; canEdit: boolean }) {
  const t = useTranslations('anc');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const save = useMutation(
    trpc.anc.saveVisit.mutationOptions({
      onSuccess: () => {
        setError(null);
        setSaved(true);
        setDraft(blank());
        void qc.invalidateQueries({ queryKey: [['anc']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const submit = () =>
    save.mutate({
      pregnancyId: v.id,
      encounterId: null,
      visitDate: draft.visitDate,
      weightKg: numOrNull(draft.weightKg),
      bpSys: numOrNull(draft.bpSys),
      bpDia: numOrNull(draft.bpDia),
      fundalHeightCm: numOrNull(draft.fundalHeightCm),
      fhr: numOrNull(draft.fhr),
      presentation: (draft.presentation || null) as never,
      oedema: (draft.oedema || null) as never,
      urineProtein: (draft.urineProtein || null) as never,
      urineSugar: (draft.urineSugar || null) as never,
      hb: numOrNull(draft.hb),
      remarks: draft.remarks.trim() || null,
    });

  const num = (
    id: keyof Draft,
    label: string,
    extra: { unit?: string; decimal?: boolean } = {},
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`anc-v-${id}`}>
        {label}
        {extra.unit ? ` (${extra.unit})` : ''}
      </Label>
      <Input
        id={`anc-v-${id}`}
        inputMode={extra.decimal ? 'decimal' : 'numeric'}
        className="w-28"
        value={draft[id]}
        onChange={(e) => set({ [id]: e.target.value })}
      />
    </div>
  );

  return (
    <Section
      id="anc-visits"
      title={t('visits.title')}
      aside={<WeightSparkline series={v.weightSeries} />}
    >
      {v.visits.length === 0 ? (
        <p className="text-muted-foreground">{t('visits.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[56rem] border-collapse text-base"
            data-testid="anc-visit-table"
          >
            <thead>
              <tr className="border-b-2 text-left">
                {(
                  [
                    'date',
                    'ga',
                    'weight',
                    'bp',
                    'fundal',
                    'fhr',
                    'presentation',
                    'oedema',
                    'urine',
                    'hb',
                    'remarks',
                  ] as const
                ).map((c) => (
                  <th key={c} scope="col" className="px-2 py-2 font-semibold">
                    {t(`visits.col.${c}`)}
                  </th>
                ))}
                {canEdit && <th scope="col" className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {v.visits.map((x) => (
                <tr key={x.id} className="border-b" data-date={x.visitDate}>
                  <td className="px-2 py-2">{formatDate(x.visitDate)}</td>
                  <td className="px-2 py-2 tabular-nums">{x.gaLabel}</td>
                  <td className="px-2 py-2 tabular-nums">{x.weightKg ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums">
                    {x.bpSys === null ? '—' : `${x.bpSys}/${x.bpDia}`}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{x.fundalHeightCm ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums">{x.fhr ?? '—'}</td>
                  <td className="px-2 py-2">
                    {x.presentation ? t(`presentation.${x.presentation as 'cephalic'}`) : '—'}
                  </td>
                  <td className="px-2 py-2">
                    {x.oedema ? GRADE_SYMBOL[x.oedema as keyof typeof GRADE_SYMBOL] : '—'}
                  </td>
                  <td className="px-2 py-2">
                    {x.urineProtein
                      ? GRADE_SYMBOL[x.urineProtein as keyof typeof GRADE_SYMBOL]
                      : '—'}
                    {' / '}
                    {x.urineSugar ? GRADE_SYMBOL[x.urineSugar as keyof typeof GRADE_SYMBOL] : '—'}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{x.hb ?? '—'}</td>
                  <td className="px-2 py-2">{x.remarks ?? ''}</td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDraft(fromVisit(x));
                          document.getElementById('anc-v-visitDate')?.focus();
                        }}
                        aria-label={t('visits.edit', { date: formatDate(x.visitDate) })}
                      >
                        <Pencil aria-hidden />
                        {t('visits.editShort')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && v.active && (
        <form
          className="space-y-3 rounded-lg border-2 border-dashed p-3"
          aria-label={t('visits.add')}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <h3 className="text-lg font-semibold">{t('visits.add')}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="anc-v-visitDate">{t('visits.col.date')}</Label>
              <Input
                id="anc-v-visitDate"
                type="date"
                max={today()}
                value={draft.visitDate}
                onChange={(e) => set({ visitDate: e.target.value })}
                required
              />
            </div>
            {num('weightKg', t('visits.col.weight'), { unit: 'kg', decimal: true })}
            {num('bpSys', t('visits.bpSys'), { unit: 'mmHg' })}
            {num('bpDia', t('visits.bpDia'), { unit: 'mmHg' })}
            {num('fundalHeightCm', t('visits.col.fundal'), { unit: 'cm', decimal: true })}
            {num('fhr', t('visits.col.fhr'), { unit: '/min' })}
            {num('hb', t('visits.col.hb'), { unit: 'g/dL', decimal: true })}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="anc-v-presentation">{t('visits.col.presentation')}</Label>
              <Select
                id="anc-v-presentation"
                value={draft.presentation}
                onChange={(e) => set({ presentation: e.target.value })}
              >
                <option value="">—</option>
                {PRESENTATIONS.map((p) => (
                  <option key={p} value={p}>
                    {t(`presentation.${p}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-v-oedema">{t('visits.col.oedema')}</Label>
              <Select
                id="anc-v-oedema"
                value={draft.oedema}
                onChange={(e) => set({ oedema: e.target.value })}
              >
                <option value="">—</option>
                {OEDEMA.map((g) => (
                  <option key={g} value={g}>
                    {GRADE_SYMBOL[g]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-v-urineProtein">{t('visits.urineProtein')}</Label>
              <Select
                id="anc-v-urineProtein"
                value={draft.urineProtein}
                onChange={(e) => set({ urineProtein: e.target.value })}
              >
                <option value="">—</option>
                {DIPSTICK.map((g) => (
                  <option key={g} value={g}>
                    {GRADE_SYMBOL[g]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-v-urineSugar">{t('visits.urineSugar')}</Label>
              <Select
                id="anc-v-urineSugar"
                value={draft.urineSugar}
                onChange={(e) => set({ urineSugar: e.target.value })}
              >
                <option value="">—</option>
                {DIPSTICK.map((g) => (
                  <option key={g} value={g}>
                    {GRADE_SYMBOL[g]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-60 flex-1 space-y-1">
              <Label htmlFor="anc-v-remarks">{t('visits.col.remarks')}</Label>
              <Input
                id="anc-v-remarks"
                value={draft.remarks}
                onChange={(e) => set({ remarks: e.target.value })}
              />
            </div>
          </div>
          <FormStatus error={error} success={saved ? t('visits.saved') : null} />
          <div className="flex justify-end">
            <Button type="submit" size="lg" disabled={save.isPending}>
              <Save aria-hidden />
              {t('visits.save')}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
