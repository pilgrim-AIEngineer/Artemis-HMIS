'use client';

import { BLOOD_GROUPS, PLURALITIES, type Plurality } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Baby } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { numOrNull, Section, today, type PatientAnc } from './anc-common';
import {
  fromHistory,
  HistoryEditor,
  toHistoryInput,
  type HistoryDraft,
} from './anc-history-editor';

/**
 * Opens the pregnancy record (docs/11 §3.1): LMP (date) or "unknown" with the GA found by a scan,
 * blood group, number of babies and earlier pregnancies. EDD, GA and G P A L follow from these.
 * A double submit with the same key returns the same record.
 */
export function AncCreate({ data }: { data: PatientAnc }) {
  const t = useTranslations('anc');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [lmpKnown, setLmpKnown] = useState(true);
  const [lmp, setLmp] = useState('');
  const [withScan, setWithScan] = useState(false);
  const [scanDate, setScanDate] = useState('');
  const [weeks, setWeeks] = useState('');
  const [days, setDays] = useState('0');
  const [blood, setBlood] = useState('');
  const [plurality, setPlurality] = useState<Plurality>('single');
  const [history, setHistory] = useState<HistoryDraft[]>(() => fromHistory(data.history));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(
    trpc.anc.create.mutationOptions({
      onSuccess: () => {
        setError(null);
        void qc.invalidateQueries({ queryKey: [['anc']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const scanNeeded = !lmpKnown || withScan;

  const submit = () => {
    setError(null);
    create.mutate({
      patientId: data.patient.id,
      idempotencyKey: key.current,
      lmp: lmpKnown ? lmp : null,
      scan: scanNeeded
        ? { date: scanDate, ga: { weeks: numOrNull(weeks) ?? -1, days: numOrNull(days) ?? 0 } }
        : null,
      bloodGroupRh: (blood || null) as never,
      plurality,
      history: toHistoryInput(history),
      notes: notes.trim() || null,
    });
  };

  return (
    <Section id="anc-create" title={t('create.title')}>
      <p className="text-muted-foreground">{t('create.hint')}</p>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-base font-medium">{t('create.lmpLegend')}</legend>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex min-h-12 items-center gap-2 text-lg">
              <input
                type="radio"
                name="lmpKnown"
                checked={lmpKnown}
                onChange={() => setLmpKnown(true)}
                className="size-5 accent-primary"
              />
              {t('create.lmpKnown')}
            </label>
            <label className="flex min-h-12 items-center gap-2 text-lg">
              <input
                type="radio"
                name="lmpKnown"
                checked={!lmpKnown}
                onChange={() => setLmpKnown(false)}
                className="size-5 accent-primary"
              />
              {t('create.lmpUnknown')}
            </label>
            {lmpKnown && (
              <div className="space-y-1">
                <Label htmlFor="anc-lmp">{t('lmp')}</Label>
                <Input
                  id="anc-lmp"
                  type="date"
                  max={today()}
                  value={lmp}
                  onChange={(e) => setLmp(e.target.value)}
                  required
                />
              </div>
            )}
          </div>
        </fieldset>

        {lmpKnown && (
          <label className="flex min-h-12 items-center gap-2 text-lg">
            <input
              type="checkbox"
              checked={withScan}
              onChange={(e) => setWithScan(e.target.checked)}
              className="size-5 accent-primary"
            />
            {t('create.hasScan')}
          </label>
        )}
        {scanNeeded && (
          <div className="flex flex-wrap items-end gap-4" data-testid="anc-create-scan">
            <div className="space-y-1">
              <Label htmlFor="anc-scan-date">{t('scanDate')}</Label>
              <Input
                id="anc-scan-date"
                type="date"
                max={today()}
                value={scanDate}
                onChange={(e) => setScanDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-scan-weeks">{t('scanWeeks')}</Label>
              <Input
                id="anc-scan-weeks"
                inputMode="numeric"
                className="w-28"
                value={weeks}
                onChange={(e) => setWeeks(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="anc-scan-days">{t('scanDays')}</Label>
              <Input
                id="anc-scan-days"
                inputMode="numeric"
                className="w-28"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <Label htmlFor="anc-blood">{t('bloodGroup')}</Label>
            <Select id="anc-blood" value={blood} onChange={(e) => setBlood(e.target.value)}>
              <option value="">{t('notKnown')}</option>
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="anc-plurality">{t('plurality.label')}</Label>
            <Select
              id="anc-plurality"
              value={plurality}
              onChange={(e) => setPlurality(e.target.value as Plurality)}
            >
              {PLURALITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`plurality.${p}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-lg font-semibold">{t('history.title')}</h3>
          <HistoryEditor rows={history} onChange={setHistory} />
        </div>

        <div className="space-y-1">
          <Label htmlFor="anc-notes">{t('notes')}</Label>
          <Input id="anc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <FormStatus error={error} />
        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={create.isPending}>
            <Baby aria-hidden />
            {t('create.submit')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
