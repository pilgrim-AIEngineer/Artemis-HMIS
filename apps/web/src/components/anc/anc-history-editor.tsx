'use client';

import { OB_OUTCOMES, type ObOutcome } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { numOrNull } from './anc-common';

/** One earlier pregnancy as typed (strings), converted by `toHistoryInput` on save. */
export interface HistoryDraft {
  year: string;
  outcome: ObOutcome;
  gestationWeeks: string;
  babiesAlive: string;
  neonatalDeath: boolean;
  place: string;
  complications: string;
}

export const emptyHistoryRow = (): HistoryDraft => ({
  year: '',
  outcome: 'nvd',
  gestationWeeks: '',
  babiesAlive: '1',
  neonatalDeath: false,
  place: '',
  complications: '',
});

export function fromHistory(
  rows: {
    year: number | null;
    outcome: ObOutcome;
    gestationWeeks: number | null;
    babiesAlive: number;
    neonatalDeath: boolean;
    place: string | null;
    complications: string | null;
  }[],
): HistoryDraft[] {
  return rows.map((r) => ({
    year: r.year === null ? '' : String(r.year),
    outcome: r.outcome,
    gestationWeeks: r.gestationWeeks === null ? '' : String(r.gestationWeeks),
    babiesAlive: String(r.babiesAlive),
    neonatalDeath: r.neonatalDeath,
    place: r.place ?? '',
    complications: r.complications ?? '',
  }));
}

export const toHistoryInput = (rows: HistoryDraft[]) =>
  rows.map((r) => ({
    year: numOrNull(r.year),
    outcome: r.outcome,
    gestationWeeks: numOrNull(r.gestationWeeks),
    babiesAlive: numOrNull(r.babiesAlive) ?? 0,
    neonatalDeath: r.neonatalDeath,
    place: r.place.trim() || null,
    complications: r.complications.trim() || null,
  }));

/**
 * Earlier pregnancies (docs/04 `obstetric_history`), one row each. G P A L is computed from them
 * plus the current pregnancy; a row is outcome, year, weeks, babies alive.
 */
export function HistoryEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: HistoryDraft[];
  onChange: (rows: HistoryDraft[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('anc');
  const set = (i: number, patch: Partial<HistoryDraft>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3" data-testid="anc-history-editor">
      {rows.length === 0 && <p className="text-muted-foreground">{t('history.none')}</p>}
      {rows.map((r, i) => (
        <fieldset
          key={i}
          className="grid grid-cols-2 items-end gap-3 rounded-lg border-2 p-3 md:grid-cols-4 lg:grid-cols-7"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-semibold">{t('history.row', { n: i + 1 })}</legend>
          <div className="space-y-1">
            <Label htmlFor={`h-out-${i}`}>{t('history.outcome')}</Label>
            <Select
              id={`h-out-${i}`}
              value={r.outcome}
              onChange={(e) => set(i, { outcome: e.target.value as ObOutcome })}
            >
              {OB_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {t(`obOutcome.${o}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`h-year-${i}`}>{t('history.year')}</Label>
            <Input
              id={`h-year-${i}`}
              inputMode="numeric"
              value={r.year}
              onChange={(e) => set(i, { year: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`h-weeks-${i}`}>{t('history.weeks')}</Label>
            <Input
              id={`h-weeks-${i}`}
              inputMode="numeric"
              value={r.gestationWeeks}
              onChange={(e) => set(i, { gestationWeeks: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`h-alive-${i}`}>{t('history.alive')}</Label>
            <Input
              id={`h-alive-${i}`}
              inputMode="numeric"
              value={r.babiesAlive}
              onChange={(e) => set(i, { babiesAlive: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id={`h-nnd-${i}`}
              checked={r.neonatalDeath}
              onChange={(e) => set(i, { neonatalDeath: e.target.checked })}
            />
            <Label htmlFor={`h-nnd-${i}`}>{t('history.neonatalDeath')}</Label>
          </div>
          <div className="col-span-2 space-y-1 md:col-span-3 lg:col-span-1">
            <Label htmlFor={`h-comp-${i}`}>{t('history.complications')}</Label>
            <Input
              id={`h-comp-${i}`}
              value={r.complications}
              onChange={(e) => set(i, { complications: e.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label={t('history.remove', { n: i + 1 })}
          >
            <Trash2 aria-hidden />
            {t('history.removeShort')}
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || rows.length >= 20}
        onClick={() => onChange([...rows, emptyHistoryRow()])}
      >
        <Plus aria-hidden />
        {t('history.add')}
      </Button>
    </div>
  );
}
