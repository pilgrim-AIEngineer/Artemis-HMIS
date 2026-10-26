'use client';

import {
  BLOOD_GROUPS,
  MANUAL_RISK_CODES,
  PLURALITIES,
  type ManualRiskCode,
  type Plurality,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { numOrNull, riskLabel, Section, type PregnancyView } from './anc-common';
import {
  fromHistory,
  HistoryEditor,
  toHistoryInput,
  type HistoryDraft,
} from './anc-history-editor';

/**
 * Blood group, number of babies, manual risk flags (docs/11 §3.2) and notes; the auto flags are
 * computed and cannot be edited here. Saving recomputes the flags and the patient's alert.
 */
export function DetailsSection({ v, canEdit }: { v: PregnancyView; canEdit: boolean }) {
  const t = useTranslations('anc');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [blood, setBlood] = useState(v.bloodGroupRh ?? '');
  const [plurality, setPlurality] = useState<Plurality>(v.plurality);
  const [manual, setManual] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(v.manualRisks.map((m) => [m.code, m.text ?? ''])),
  );
  const [notes, setNotes] = useState(v.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation(
    trpc.anc.update.mutationOptions({
      onSuccess: () => {
        setError(null);
        setSaved(true);
        void qc.invalidateQueries({ queryKey: [['anc']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const toggle = (code: ManualRiskCode, on: boolean) => {
    setSaved(false);
    setManual((m) => {
      const next = { ...m };
      if (on) next[code] = next[code] ?? '';
      else delete next[code];
      return next;
    });
  };

  return (
    <Section id="anc-details" title={t('details.title')}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            pregnancyId: v.id,
            bloodGroupRh: (blood || null) as never,
            plurality,
            manualRisks: Object.entries(manual).map(([code, text]) => ({
              code: code as ManualRiskCode,
              text: code === 'other' ? (text ?? '').trim() || null : null,
            })),
            notes: notes.trim() || null,
          });
        }}
      >
        <fieldset className="flex flex-wrap gap-4" disabled={!canEdit}>
          <div className="space-y-1">
            <Label htmlFor="anc-d-blood">{t('bloodGroup')}</Label>
            <Select
              id="anc-d-blood"
              value={blood}
              onChange={(e) => {
                setSaved(false);
                setBlood(e.target.value);
              }}
            >
              <option value="">{t('notKnown')}</option>
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="anc-d-plurality">{t('plurality.label')}</Label>
            <Select
              id="anc-d-plurality"
              value={plurality}
              onChange={(e) => {
                setSaved(false);
                setPlurality(e.target.value as Plurality);
              }}
            >
              {PLURALITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`plurality.${p}`)}
                </option>
              ))}
            </Select>
          </div>
        </fieldset>

        <fieldset className="space-y-2" disabled={!canEdit}>
          <legend className="text-base font-medium">{t('details.manualRisks')}</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {MANUAL_RISK_CODES.map((code) => (
              <label key={code} className="flex min-h-11 items-center gap-2 text-lg">
                <Checkbox
                  checked={code in manual}
                  onChange={(e) => toggle(code, e.target.checked)}
                  data-testid={`anc-manual-${code}`}
                />
                {riskLabel(t, code)}
              </label>
            ))}
          </div>
          {'other' in manual && (
            <div className="max-w-xl space-y-1">
              <Label htmlFor="anc-d-other">{t('details.otherText')}</Label>
              <Input
                id="anc-d-other"
                value={manual.other ?? ''}
                onChange={(e) => {
                  setSaved(false);
                  setManual((m) => ({ ...m, other: e.target.value }));
                }}
              />
            </div>
          )}
        </fieldset>

        <div className="max-w-xl space-y-1">
          <Label htmlFor="anc-d-notes">{t('notes')}</Label>
          <Input
            id="anc-d-notes"
            value={notes}
            disabled={!canEdit}
            onChange={(e) => {
              setSaved(false);
              setNotes(e.target.value);
            }}
          />
        </div>
        <FormStatus error={error} success={saved ? t('details.saved') : null} />
        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending}>
              <Save aria-hidden />
              {t('details.save')}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}

/** Earlier pregnancies and the G P A L they produce; the score can be typed by hand and restored. */
export function HistorySection({ v, canEdit }: { v: PregnancyView; canEdit: boolean }) {
  const t = useTranslations('anc');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [rows, setRows] = useState<HistoryDraft[]>(() => fromHistory(v.history));
  const [g, setG] = useState({
    g: String(v.gpal.g),
    p: String(v.gpal.p),
    a: String(v.gpal.a),
    l: String(v.gpal.l),
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const done = {
    onSuccess: () => {
      setError(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: [['anc']] });
    },
    onError: (e: unknown) => setError(errorText(e)),
  };
  const saveHistory = useMutation(trpc.anc.saveHistory.mutationOptions(done));
  const setGpal = useMutation(trpc.anc.setGpal.mutationOptions(done));

  return (
    <Section
      id="anc-history"
      title={t('history.title')}
      aside={
        <p className="text-xl font-semibold" data-testid="anc-gpal">
          {v.gpal.text}
          {v.gpal.manual && (
            <span className="ml-2 text-sm text-muted-foreground">{t('gpal.manual')}</span>
          )}
        </p>
      }
    >
      <HistoryEditor
        rows={rows}
        onChange={(r) => {
          setSaved(false);
          setRows(r);
        }}
        disabled={!canEdit}
      />
      {canEdit && (
        <>
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={saveHistory.isPending}
              onClick={() =>
                saveHistory.mutate({ pregnancyId: v.id, history: toHistoryInput(rows) })
              }
            >
              <Save aria-hidden />
              {t('history.save')}
            </Button>
          </div>
          <fieldset className="space-y-2 rounded-lg border-2 p-3">
            <legend className="px-1 text-base font-medium">{t('gpal.edit')}</legend>
            <div className="flex flex-wrap items-end gap-3">
              {(['g', 'p', 'a', 'l'] as const).map((k) => (
                <div key={k} className="space-y-1">
                  <Label htmlFor={`anc-gpal-${k}`}>{k.toUpperCase()}</Label>
                  <Input
                    id={`anc-gpal-${k}`}
                    inputMode="numeric"
                    className="w-20"
                    value={g[k]}
                    onChange={(e) => {
                      setSaved(false);
                      setG((x) => ({ ...x, [k]: e.target.value }));
                    }}
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={setGpal.isPending}
                onClick={() =>
                  setGpal.mutate({
                    pregnancyId: v.id,
                    manual: true,
                    g: numOrNull(g.g) ?? 1,
                    p: numOrNull(g.p) ?? 0,
                    a: numOrNull(g.a) ?? 0,
                    l: numOrNull(g.l) ?? 0,
                  })
                }
              >
                {t('gpal.set')}
              </Button>
              {v.gpal.manual && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={setGpal.isPending}
                  onClick={() => setGpal.mutate({ pregnancyId: v.id, manual: false })}
                >
                  {t('gpal.restore')}
                </Button>
              )}
            </div>
          </fieldset>
        </>
      )}
      <FormStatus error={error} success={saved ? t('history.saved') : null} />
    </Section>
  );
}
