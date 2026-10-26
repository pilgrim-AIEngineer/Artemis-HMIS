'use client';

import { formatDate, formatDateTime, IMMUNISATION_SCHEDULES } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Syringe, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Section } from '@/components/anc/anc-common';
import { FormStatus } from '@/components/form/text-field';
import { PrintButton } from '@/components/print/print-button';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { DoseDialog } from './dose-dialog';
import { key, type CardRow, type ImmunisationCard } from './paeds-common';

const TONE: Record<string, string> = {
  overdue: 'border-destructive bg-red-50 text-red-950',
  due: 'border-amber-600 bg-amber-50 text-amber-950',
  upcoming: 'border-border text-muted-foreground',
  given: 'border-money text-money',
  not_applicable: 'border-border text-muted-foreground',
};

/** Summary: next due date, schedule, WhatsApp reminder and the prints (docs/11 §4.1). */
export function ImmunisationSummary({
  card,
  canEdit,
}: {
  card: ImmunisationCard;
  canEdit: boolean;
}) {
  const t = useTranslations('paeds');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: [['paeds']] });
  const setSchedule = useMutation(
    trpc.paeds.setSchedule.mutationOptions({
      onSuccess: () => {
        setError(null);
        refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const setConsent = useMutation(
    trpc.paeds.setConsent.mutationOptions({
      onSuccess: () => {
        setError(null);
        refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const consent = card.whatsappConsent;
  const id = card.patient.id;

  return (
    <Section
      id="paeds-summary"
      title={t('summary.title')}
      aside={
        <span className="flex flex-wrap gap-2">
          <PrintButton
            template="vaccination-card"
            entityId={id}
            label={t('print.card')}
            variant="outline"
            shortcut={false}
          />
          <PrintButton
            template="vaccination-certificate"
            entityId={id}
            label={t('print.certificate')}
            variant="outline"
            shortcut={false}
          />
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
        <div>
          <dt className="text-sm text-muted-foreground">{t('nextDue')}</dt>
          <dd className="text-2xl font-semibold" data-testid="paeds-next-due">
            {card.nextDueDate ? formatDate(card.nextDueDate) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t('summary.schedule')}</dt>
          <dd className="text-lg">
            {canEdit ? (
              <>
                <Label htmlFor="paeds-schedule" className="sr-only">
                  {t('summary.schedule')}
                </Label>
                <Select
                  id="paeds-schedule"
                  value={card.scheduleName}
                  disabled={setSchedule.isPending}
                  onChange={(e) =>
                    setSchedule.mutate({
                      patientId: id,
                      scheduleName: e.target.value as (typeof IMMUNISATION_SCHEDULES)[number],
                    })
                  }
                >
                  {IMMUNISATION_SCHEDULES.map((s) => (
                    <option key={s} value={s}>
                      {key(t)(`schedule.${s}`)}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <span data-testid="paeds-schedule">{key(t)(`schedule.${card.scheduleName}`)}</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="space-y-2" data-testid="paeds-reminder">
        <h3 className="text-lg font-semibold">{t('reminder.title')}</h3>
        {canEdit && (
          <label className="flex min-h-11 items-center gap-3 text-lg">
            <Checkbox
              checked={consent === true}
              disabled={setConsent.isPending}
              onChange={(e) => setConsent.mutate({ patientId: id, granted: e.target.checked })}
            />
            {t('reminder.consent')}
          </label>
        )}
        {!canEdit && consent !== null && (
          <p>{consent ? t('reminder.consentYes') : t('reminder.consentNo')}</p>
        )}
        {consent === null && (
          <p className="text-muted-foreground">{t('reminder.consentUnknown')}</p>
        )}
        {!card.patient.mobile && consent && (
          <p className="font-medium text-amber-900">▲ {t('reminder.noMobile')}</p>
        )}
        {card.reminders.length > 0 ? (
          <ul className="space-y-1" data-testid="paeds-reminder-queued">
            {card.reminders.map((r) => (
              <li key={r.id} className="rounded-md border-2 border-money px-3 py-1 text-money">
                {t('reminder.queued', {
                  due: formatDate(r.dueDate),
                  send: formatDateTime(new Date(r.sendAfter)),
                  vaccines: r.vaccines.join(', '),
                })}
              </li>
            ))}
          </ul>
        ) : (
          consent === true && <p className="text-muted-foreground">{t('reminder.none')}</p>
        )}
      </div>
      <FormStatus error={error} />
    </Section>
  );
}

/** Doses still to give (upcoming, due, overdue) with their due dates and a Record button. */
export function ScheduleSection({ card, canEdit }: { card: ImmunisationCard; canEdit: boolean }) {
  const t = useTranslations('paeds');
  const locale = useLocale();
  const [recording, setRecording] = useState<{ row: CardRow | null } | null>(null);
  const [showOptional, setShowOptional] = useState(true);
  const outstanding = card.rows
    .filter((r) => r.status === 'upcoming' || r.status === 'due' || r.status === 'overdue')
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.code.localeCompare(b.code));
  const shown = outstanding.filter((r) => showOptional || !r.item.isOptional);
  const closed = card.rows.filter((r) => r.status === 'not_applicable');
  const name = (r: CardRow) => (locale === 'hi' ? r.item.labelHi : r.item.label);

  return (
    <Section
      id="paeds-schedule"
      title={t('schedule.title', { name: key(t)(`schedule.${card.scheduleName}`) })}
      aside={
        canEdit ? (
          <Button type="button" variant="outline" onClick={() => setRecording({ row: null })}>
            <Syringe aria-hidden />
            {t('dialog.other')}
          </Button>
        ) : undefined
      }
    >
      <label className="flex min-h-11 items-center gap-3 text-base">
        <Checkbox checked={showOptional} onChange={(e) => setShowOptional(e.target.checked)} />
        {t('schedule.showOptional')}
      </label>
      {shown.length === 0 ? (
        <p className="text-muted-foreground" data-testid="paeds-nothing-due">
          {t('schedule.nothingLeft')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[40rem] border-collapse text-base"
            data-testid="paeds-schedule-table"
          >
            <thead>
              <tr className="border-b-2 text-left">
                <th scope="col" className="px-2 py-2 font-semibold">
                  {t('col.vaccine')}
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  {t('col.dueOn')}
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  {t('col.status')}
                </th>
                {canEdit && <th scope="col" className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.code} className="border-b" data-code={r.code} data-status={r.status}>
                  <td className="px-2 py-2 text-lg font-medium">
                    {name(r)}
                    {r.item.isOptional && (
                      <span className="ml-2 text-sm text-muted-foreground">
                        ({t('schedule.optional')})
                      </span>
                    )}
                    {r.waitingFor && (
                      <span className="block text-sm font-normal text-muted-foreground">
                        {t('schedule.waitingFor', { code: r.waitingFor })}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{formatDate(r.dueDate!)}</td>
                  <td className="px-2 py-2">
                    <span
                      className={cn(
                        'rounded-full border-2 px-3 py-0.5 text-sm font-bold',
                        TONE[r.status],
                      )}
                    >
                      {r.status === 'overdue' ? '▲ ' : ''}
                      {key(t)(`state.${r.status}`)}
                      {r.status === 'overdue' ? ` · ${t('overdueBy', { count: r.daysLate })}` : ''}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setRecording({ row: r })}
                        aria-label={t('schedule.recordFor', { name: name(r) })}
                      >
                        <Syringe aria-hidden />
                        {t('schedule.record')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closed.length > 0 && (
        <details className="text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-2">
            {t('schedule.closedTitle', { count: closed.length })}
          </summary>
          <ul className="space-y-1" data-testid="paeds-closed">
            {closed.map((r) => (
              <li key={r.code}>
                {name(r)} · {key(t)(`naReason.${r.notApplicable}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {recording && (
        <DoseDialog
          key={recording.row?.code ?? 'other'}
          patientId={card.patient.id}
          row={recording.row}
          other={recording.row === null}
          onClose={() => setRecording(null)}
        />
      )}
    </Section>
  );
}

/** Doses given, with batch and expiry; a wrong entry is cancelled with a reason, never deleted. */
export function GivenSection({ card, canEdit }: { card: ImmunisationCard; canEdit: boolean }) {
  const t = useTranslations('paeds');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation(
    trpc.paeds.cancelDose.mutationOptions({
      onSuccess: () => {
        setCancelling(null);
        setReason('');
        setError(null);
        void qc.invalidateQueries({ queryKey: [['paeds']] });
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const byCode = new Map(card.rows.map((r) => [r.code, r.item]));
  const label = (g: ImmunisationCard['given'][number]) => {
    const item = g.itemCode ? byCode.get(g.itemCode) : undefined;
    return item ? (locale === 'hi' ? item.labelHi : item.label) : g.vaccineName;
  };
  const rows = [...card.given].sort((a, b) => b.givenOn.localeCompare(a.givenOn));

  return (
    <Section id="paeds-given" title={t('given.title')}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground" data-testid="paeds-given-empty">
          {t('given.none')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[44rem] border-collapse text-base"
            data-testid="paeds-given-table"
          >
            <thead>
              <tr className="border-b-2 text-left">
                {(['vaccine', 'givenOn', 'brand', 'batch', 'expiry', 'site'] as const).map((c) => (
                  <th key={c} scope="col" className="px-2 py-2 font-semibold">
                    {t(`col.${c}`)}
                  </th>
                ))}
                {canEdit && <th scope="col" className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-b" data-code={g.itemCode ?? ''}>
                  <td className="px-2 py-2 text-lg font-medium">{label(g)}</td>
                  <td className="px-2 py-2 tabular-nums">{formatDate(g.givenOn)}</td>
                  <td className="px-2 py-2">{g.brand ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums" data-testid="paeds-batch">
                    {g.batchNo}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{formatDate(g.expiry)}</td>
                  <td className="px-2 py-2">{key(t)(`site.${g.site}`)}</td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCancelling(g.id);
                          setReason('');
                        }}
                        aria-label={t('given.cancelFor', { name: label(g) })}
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
      {cancelling && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border-2 border-dashed p-3"
          onSubmit={(e) => {
            e.preventDefault();
            cancel.mutate({ id: cancelling, reason });
          }}
        >
          <div className="min-w-64 flex-1 space-y-1">
            <Label htmlFor="paeds-cancel-reason">{t('given.reason')}</Label>
            <Input
              id="paeds-cancel-reason"
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
      <FormStatus error={error} />
    </Section>
  );
}
