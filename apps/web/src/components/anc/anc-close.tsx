'use client';

import { PREGNANCY_CLOSE_OUTCOMES } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { numOrNull, Section, today, type PregnancyView } from './anc-common';

/**
 * Closing the pregnancy (docs/11 §3.1). A delivery names its mode so the next pregnancy's history
 * is right. MTP is offered only to users who may record it; the server checks again, and everyone
 * else sees such a pregnancy as "closed".
 */
export function CloseSection({ v, canMtp }: { v: PregnancyView; canMtp: boolean }) {
  const t = useTranslations('anc');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<(typeof PREGNANCY_CLOSE_OUTCOMES)[number]>('delivered');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<'nvd' | 'lscs' | 'assisted' | 'stillbirth'>('nvd');
  const [alive, setAlive] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = useMutation(
    trpc.anc.close.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: [['anc']] }),
      onError: (e) => setError(errorText(e)),
    }),
  );
  const outcomes = PREGNANCY_CLOSE_OUTCOMES.filter((o) => o !== 'mtp' || canMtp);

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          {t('close.open')}
        </Button>
      </div>
    );
  }
  return (
    <Section id="anc-close" title={t('close.title')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          close.mutate({
            pregnancyId: v.id,
            outcome,
            outcomeDate: date,
            reason: reason.trim() || null,
            obOutcome: outcome === 'delivered' ? mode : null,
            babiesAlive: outcome === 'delivered' ? numOrNull(alive) : null,
            neonatalDeath: false,
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="anc-c-outcome">{t('close.outcome')}</Label>
            <Select
              id="anc-c-outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            >
              {outcomes.map((o) => (
                <option key={o} value={o}>
                  {t(`outcome.${o}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="anc-c-date">{t('close.date')}</Label>
            <Input
              id="anc-c-date"
              type="date"
              max={today()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          {outcome === 'delivered' && (
            <>
              <div className="space-y-1">
                <Label htmlFor="anc-c-mode">{t('close.mode')}</Label>
                <Select
                  id="anc-c-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  {(['nvd', 'lscs', 'assisted', 'stillbirth'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`obOutcome.${m}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="anc-c-alive">{t('close.alive')}</Label>
                <Input
                  id="anc-c-alive"
                  inputMode="numeric"
                  className="w-24"
                  value={alive}
                  onChange={(e) => setAlive(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
        {outcome !== 'mtp' && (
          <div className="max-w-xl space-y-1">
            <Label htmlFor="anc-c-reason">{t('close.reason')}</Label>
            <Input id="anc-c-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        <FormStatus error={error} />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t('close.cancel')}
          </Button>
          <Button type="submit" disabled={close.isPending}>
            {t('close.submit')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
