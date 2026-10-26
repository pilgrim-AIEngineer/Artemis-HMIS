'use client';

import {
  formatDate,
  formatINR,
  QUEUE_PRIORITIES,
  VISIT_TYPES,
  type QueuePriority,
  type VisitType,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { PatientHeader } from '@hmis/ui/components/patient-header';
import { Select } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Ticket } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { PrintButton } from '@/components/print/print-button';
import { PrintOnMount } from '@/components/print/print-on-mount';
import { useAgeText } from '@/lib/use-age-text';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

const DOCTOR_KEY = 'hmis.visit.doctor';

/**
 * New OPD visit (REG-03, docs/10 §4): choose the doctor (large buttons, last one pre-selected),
 * see the suggested visit type and the fee from the tariff, then save. The same `idempotencyKey`
 * is used for every submit of this form, so a double click or a retry after a network blip cannot
 * make two visits. The fee is shown, not typed: concessions go through a discount with approval.
 */
export function VisitForm({ patientId }: { patientId: string }) {
  const t = useTranslations('visit');
  const tQ = useTranslations('queue');
  const tR = useTranslations('reception');
  const errorText = useErrorText();
  const ageText = useAgeText();
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { me } = useSession();
  const canRelease = me.permissions.includes('billing.payment.collect');

  const patient = useQuery(trpc.patients.get.queryOptions({ id: patientId }));
  const doctors = useQuery(trpc.visit.doctors.queryOptions());

  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [visitType, setVisitType] = useState<VisitType | null>(null);
  const [priority, setPriority] = useState<QueuePriority>('normal');
  const [complaint, setComplaint] = useState('');
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [error, setError] = useState<{ text: string; key: string } | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  // Default doctor: the last one used at this workstation, else the only one.
  const list = doctors.data ?? [];
  const chosen =
    doctorId ??
    (list.length === 1
      ? list[0]!.id
      : (list.find(
          (d) =>
            d.id ===
            (typeof window === 'undefined' ? null : window.localStorage.getItem(DOCTOR_KEY)),
        )?.id ?? null));
  useEffect(() => {
    if (chosen) window.localStorage.setItem(DOCTOR_KEY, chosen);
  }, [chosen]);

  const preview = useQuery(
    trpc.visit.preview.queryOptions(
      chosen ? { patientId, doctorId: chosen, visitType: visitType ?? undefined } : skipToken,
    ),
  );
  const p = preview.data;
  const effectiveType = visitType ?? p?.suggestedVisitType ?? 'new';

  const create = useMutation(
    trpc.visit.create.mutationOptions({
      onError: (e) =>
        setError({ text: errorText(e), key: (e as { message?: string }).message ?? '' }),
      onSuccess: () => {
        setError(null);
        void queryClient.invalidateQueries({ queryKey: [['queue']] });
      },
    }),
  );
  const issue = useMutation(
    trpc.visit.issueToken.mutationOptions({
      onError: (e) => setError({ text: errorText(e), key: '' }),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['queue']] }),
    }),
  );

  if (patient.isPending || doctors.isPending) {
    return <div className="h-40 animate-pulse rounded-lg bg-muted" aria-busy="true" />;
  }
  const pt = patient.data;
  if (!pt) {
    return (
      <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
        {t('patientNotFound')}
      </p>
    );
  }

  const created = create.data;
  const fee = created ? BigInt(created.feePaise) : (p?.fee.ratePaise ?? 0n);
  const feeMissing =
    (created?.feeBasis ?? p?.fee.basis) === 'no_rule' ||
    (created?.feeBasis ?? p?.fee.basis) === 'no_rate';
  const followUpLine = (() => {
    if (!p) return null;
    const f = p.followUp;
    if (f.eligible)
      return t('followUp.valid', { date: formatDate(f.validUntil!), left: f.remainingFollowUps });
    if (f.reason === 'exhausted') return t('followUp.exhausted');
    if (f.reason === 'expired') return t('followUp.expired', { date: formatDate(f.indexDate!) });
    if (f.reason === 'disabled') return t('followUp.disabled');
    return null;
  })();

  const submit = () => {
    if (!chosen || create.isPending) return;
    create.mutate({
      patientId,
      doctorId: chosen,
      visitType: effectiveType,
      priority,
      chiefComplaint: complaint || undefined,
      allowRepeatToday: allowRepeat,
      idempotencyKey: idempotencyKey.current,
    });
  };

  const header = (
    <PatientHeader
      name={pt.fullName}
      nameHi={pt.nameHi}
      ageSex={`${ageText(pt.dob)} / ${tR(`sex.${pt.sex as 'F' | 'M' | 'O'}`)}`}
      uhid={pt.uhid}
      mobileLast4={pt.mobile?.slice(-4)}
      mobileLabel={tR('columns.mobile')}
    />
  );

  if (created) {
    return (
      <div className="space-y-5">
        {header}
        <section
          aria-labelledby="visit-done"
          className="space-y-4 rounded-lg border-2 border-money p-5"
          data-testid="visit-created"
        >
          <h1 id="visit-done" className="text-2xl font-semibold">
            {t('created', { number: created.number })}
          </h1>
          {created.tokenNo !== null ? (
            <p className="text-6xl font-bold tabular-nums" role="status">
              <span className="text-2xl font-semibold text-muted-foreground">
                {t('tokenLabel')}{' '}
              </span>
              {created.tokenNo}
            </p>
          ) : (
            <p className="text-xl" role="status">
              {feeMissing ? t('feeMissing') : t('collectThenToken', { amount: formatINR(fee) })}
            </p>
          )}
          {issue.data && (
            <p className="text-6xl font-bold tabular-nums" role="status">
              <span className="text-2xl font-semibold text-muted-foreground">
                {t('tokenLabel')}{' '}
              </span>
              {issue.data.tokenNo}
            </p>
          )}
          {error && (
            <p role="alert" className="font-medium text-destructive">
              {error.text}
            </p>
          )}
          {(created.printSheet || issue.data?.printSheet) && (
            <PrintOnMount template="opd-sheet" entityId={created.encounterId} />
          )}
          <div className="flex flex-wrap gap-3">
            <PrintButton
              template="opd-sheet"
              entityId={created.encounterId}
              label={t('printSheet')}
              variant="outline"
              size="lg"
              shortcut={false}
            />
            {created.tokenNo === null && !issue.data && canRelease && (
              <Button
                variant="money"
                size="lg"
                disabled={issue.isPending}
                onClick={() => issue.mutate({ encounterId: created.encounterId })}
              >
                <Ticket aria-hidden />
                {t('giveToken')}
              </Button>
            )}
            <Button asChild variant="outline" size="lg">
              <Link href="/reception/queue">
                <ListChecks aria-hidden />
                {t('openQueue')}
              </Link>
            </Button>
            <Button asChild size="lg" autoFocus>
              <Link href="/reception">{tR('summary.backToSearch')}</Link>
            </Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h1 className="text-3xl font-semibold">{t('title')}</h1>

        <fieldset className="space-y-3">
          <legend className="text-xl font-semibold">{t('doctor')}</legend>
          {list.length === 0 && <p className="text-muted-foreground">{t('noDoctors')}</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={chosen === d.id}
                onClick={() => {
                  setDoctorId(d.id);
                  setVisitType(null);
                  setError(null);
                }}
                className={cn(
                  'min-h-20 rounded-lg border-2 p-4 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
                  chosen === d.id
                    ? 'border-primary bg-primary/10'
                    : 'border-input bg-card hover:bg-accent',
                )}
              >
                <span className="block text-xl font-semibold">
                  {locale === 'hi' && d.displayNameHi ? d.displayNameHi : d.displayName}
                </span>
                {d.qualifications && (
                  <span className="block text-muted-foreground">{d.qualifications}</span>
                )}
              </button>
            ))}
          </div>
        </fieldset>

        {chosen && (
          <>
            <fieldset className="space-y-3">
              <legend className="text-xl font-semibold">{t('visitType')}</legend>
              <div className="flex flex-wrap gap-3">
                {VISIT_TYPES.map((v) => (
                  <label
                    key={v}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 px-4 py-2',
                      effectiveType === v ? 'border-primary bg-primary/10' : 'border-input',
                    )}
                  >
                    <input
                      type="radio"
                      name="visitType"
                      value={v}
                      className="size-5 accent-[var(--primary)]"
                      checked={effectiveType === v}
                      onChange={() => setVisitType(v)}
                    />
                    {tQ(`visitTypes.${v}`)}
                    {p?.suggestedVisitType === v && (
                      <span className="rounded-full bg-secondary px-2 text-sm">
                        {t('suggested')}
                      </span>
                    )}
                  </label>
                ))}
              </div>
              {followUpLine && <p className="text-muted-foreground">{followUpLine}</p>}
            </fieldset>

            <section aria-live="polite" className="rounded-lg border-2 bg-card p-4">
              <p className="text-muted-foreground">{t('fee')}</p>
              {preview.isPending || !p ? (
                <div className="mt-1 h-9 w-40 animate-pulse rounded bg-muted" aria-busy="true" />
              ) : feeMissing ? (
                <p className="text-xl font-semibold text-destructive">{t('feeNotSet')}</p>
              ) : (
                <p className="text-3xl font-bold tabular-nums" data-testid="visit-fee">
                  {fee === 0n ? t('feeFree') : formatINR(fee)}
                </p>
              )}
              {p?.fee.serviceName && <p className="text-muted-foreground">{p.fee.serviceName}</p>}
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="visit-priority">{t('priority')}</Label>
                <Select
                  id="visit-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as QueuePriority)}
                >
                  {QUEUE_PRIORITIES.map((q) => (
                    <option key={q} value={q}>
                      {tQ(`priorities.${q}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="visit-complaint">{t('complaint')}</Label>
                <Input
                  id="visit-complaint"
                  value={complaint}
                  maxLength={200}
                  onChange={(e) => setComplaint(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        {error && (
          <div role="alert" className="space-y-3 rounded-lg border-2 border-destructive p-4">
            <p className="font-medium text-destructive">{error.text}</p>
            {error.key === 'errors.visit.alreadyToday' && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAllowRepeat(true);
                  idempotencyKey.current = crypto.randomUUID();
                  setError(null);
                }}
              >
                {t('allowRepeat')}
              </Button>
            )}
          </div>
        )}
        {allowRepeat && <p className="font-medium">{t('repeatConfirmed')}</p>}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" size="lg" disabled={!chosen || !p || create.isPending}>
            {create.isPending ? t('saving') : t('save')}
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href={`/reception/patients/${patientId}`}>{t('cancel')}</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
