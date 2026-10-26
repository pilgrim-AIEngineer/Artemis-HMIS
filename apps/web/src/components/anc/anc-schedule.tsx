'use client';

import { formatDate } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { Section, type PregnancyView } from './anc-common';

const TONE: Record<string, string> = {
  overdue: 'border-destructive bg-red-50 text-red-950',
  due: 'border-amber-600 bg-amber-50 text-amber-950',
  done: 'border-money text-money',
  skipped: 'border-border text-muted-foreground',
  upcoming: 'border-border text-muted-foreground',
};

/**
 * Tests, scans, Td doses and supplements with their state (docs/11 §3.4): due, overdue, done or
 * later. "Done" is ticked by hand here, or by itself when the matching order is completed. The
 * schedule is the draft of docs/33 §4 until the gynaecologist signs it off.
 */
export function ScheduleSection({ v, canEdit }: { v: PregnancyView; canEdit: boolean }) {
  const t = useTranslations('anc');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mark = useMutation(
    trpc.anc.markSchedule.mutationOptions({
      onSuccess: () => {
        setError(null);
        void qc.invalidateQueries({ queryKey: [['anc']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const items = v.schedule.filter((s) => s.state !== 'not_applicable');
  const set = (code: string, status: 'done' | 'skipped' | 'due') =>
    mark.mutate({ pregnancyId: v.id, code, status, doneDate: null });

  return (
    <Section id="anc-schedule" title={t('schedule.title')}>
      <ul className="grid gap-2 md:grid-cols-2" data-testid="anc-schedule-list">
        {items.map((s) => (
          <li
            key={s.code}
            data-code={s.code}
            data-state={s.state}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-2 p-2"
          >
            <div className="min-w-0 flex-1">
              <p className="text-lg font-medium">{locale === 'hi' ? s.labelHi : s.label}</p>
              <p className="text-sm text-muted-foreground">
                {s.state === 'done' && s.doneDate
                  ? `${formatDate(s.doneDate)}${s.source === 'order' ? ` · ${t('schedule.byOrder')}` : ''}`
                  : s.windowFrom
                    ? `${formatDate(s.windowFrom)}${s.windowTo ? ` – ${formatDate(s.windowTo)}` : ''}`
                    : t('schedule.afterTd1')}
              </p>
            </div>
            <span
              className={cn('rounded-full border-2 px-3 py-0.5 text-sm font-bold', TONE[s.state])}
            >
              {s.state === 'overdue' ? '▲ ' : ''}
              {t(`state.${s.state as 'due'}`)}
            </span>
            {canEdit && v.active && (
              <span className="flex gap-2">
                {s.state === 'done' || s.state === 'skipped' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={mark.isPending}
                    onClick={() => set(s.code, 'due')}
                    aria-label={t('schedule.undoFor', { name: s.label })}
                  >
                    {t('schedule.undo')}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={mark.isPending}
                      onClick={() => set(s.code, 'done')}
                      aria-label={t('schedule.doneFor', { name: s.label })}
                    >
                      {t('schedule.done')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={mark.isPending}
                      onClick={() => set(s.code, 'skipped')}
                      aria-label={t('schedule.skipFor', { name: s.label })}
                    >
                      {t('schedule.skip')}
                    </Button>
                  </>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <FormStatus error={error} />
    </Section>
  );
}
