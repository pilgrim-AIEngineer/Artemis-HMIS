'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  BLOOD_GROUPS,
  createPatientSchema,
  formatDate,
  GUARDIAN_RELATIONS,
  istToday,
  joinName,
  MARITAL_STATUSES,
  MOBILE_OWNER_RELATIONS,
  PATIENT_SEXES,
  resolveDob,
  transliterateToDevanagari,
  updatePatientSchema,
  type CreatePatientInput,
} from '@hmis/shared';
import { Button, buttonVariants } from '@hmis/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { FieldMessage, Label } from '@hmis/ui/components/label';
import { Checkbox } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { SelectField } from '@/components/form/select-field';
import { FormStatus, TextField } from '@/components/form/text-field';
import { Section } from '@/components/section';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useAgeText } from '@/lib/use-age-text';
import { useDebounced } from '@/lib/use-debounced';
import { useErrorText, useFieldError } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';
import type { AppRouter } from '@/server/trpc/root';
import type { inferRouterOutputs } from '@trpc/server';

type Matches = Extract<
  inferRouterOutputs<AppRouter>['patients']['create'],
  { status: 'duplicates' }
>['matches'];

/** Form state: the API input plus the UI-only "No mobile" tick. Blank strings mean "not given". */
type FormValues = Record<string, string>;

const FIELDS = [
  'noMobile',
  'nameHiTouched',
  'firstName',
  'middleName',
  'lastName',
  'nameHi',
  'sex',
  'dob',
  'age',
  'mobile',
  'noMobileReason',
  'altMobile',
  'relationToMobileOwner',
  'guardianName',
  'guardianRelation',
  'addressLine',
  'localityName',
  'district',
  'state',
  'pincode',
  'bloodGroup',
  'maritalStatus',
  'occupation',
  'referredBy',
] as const;

/** Drops blank values so optional zod fields see `undefined`, not `''`. */
const UI_ONLY = new Set(['noMobile', 'nameHiTouched']);
const prune = (v: Record<string, unknown>): CreatePatientInput =>
  Object.fromEntries(
    Object.entries(v).filter(
      ([k, x]) => !UI_ONLY.has(k) && x !== '' && x !== undefined && x !== null && x !== false,
    ),
  ) as unknown as CreatePatientInput;

const blank: FormValues = Object.fromEntries(FIELDS.map((f) => [f, '']));

/**
 * Patient registration and edit form (REG-01, docs/10 §3). Minimum fields first (name, sex, age or
 * date of birth, mobile), the rest under "More details". Age is typed as 25 / 6m / 15d and becomes
 * an estimated DOB on the server. A duplicate on the same mobile opens the "Possible existing
 * patient" prompt instead of saving.
 */
export function PatientForm({ patientId, familyOf }: { patientId?: string; familyOf?: string }) {
  const edit = Boolean(patientId);
  const t = useTranslations('reception.form');
  const tEnum = useTranslations('reception.enums');
  const tSex = useTranslations('reception.sex');
  const tCommon = useTranslations('common');
  const errorText = useErrorText();
  const fieldError = useFieldError();
  const ageText = useAgeText();
  const trpc = useTRPC();
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Matches | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const useThis = useRef<HTMLAnchorElement>(null);

  const resolver = useMemo<Resolver<FormValues>>(
    () => (values, ctx, opts) => {
      const schema = edit ? updatePatientSchema : createPatientSchema;
      const input = prune({ ...values, ...(patientId ? { id: patientId } : {}) });
      const run = zodResolver(schema as never) as unknown as Resolver<FormValues>;
      return run(input as unknown as FormValues, ctx, opts);
    },
    [edit, patientId],
  );
  const form = useForm<FormValues>({ resolver, defaultValues: blank, mode: 'onSubmit' });
  const { register, handleSubmit, control, setValue, reset, formState } = form;
  const err = (name: string): string | undefined => formState.errors[name]?.message;

  // --- loading: existing patient (edit) or the family member's contact details (add member)
  const existing = useQuery(
    trpc.patients.get.queryOptions(patientId ? { id: patientId } : skipToken),
  );
  const family = useQuery(trpc.patients.get.queryOptions(familyOf ? { id: familyOf } : skipToken));
  const defaults = useQuery(trpc.patients.defaults.queryOptions(undefined, { enabled: !edit }));

  useEffect(() => {
    const p = existing.data;
    if (!p) return;
    reset({
      ...blank,
      firstName: p.firstName,
      middleName: p.middleName ?? '',
      lastName: p.lastName ?? '',
      nameHi: p.nameHi ?? '',
      sex: p.sex,
      dob: p.dob,
      mobile: p.mobile ?? '',
      noMobile: p.mobile ? '' : '1',
      nameHiTouched: '1',
      noMobileReason: p.noMobileReason ?? '',
      altMobile: p.altMobile ?? '',
      relationToMobileOwner: p.relationToMobileOwner ?? '',
      guardianName: p.guardianName ?? '',
      guardianRelation: p.guardianRelation ?? '',
      addressLine: p.addressLine ?? '',
      localityName: p.localityName ?? '',
      district: p.district ?? '',
      state: p.state ?? '',
      pincode: p.pincode ?? '',
      bloodGroup: p.bloodGroup ?? '',
      maritalStatus: p.maritalStatus ?? '',
      occupation: p.occupation ?? '',
      referredBy: p.referredBy ?? '',
    });
  }, [existing.data, reset]);

  useEffect(() => {
    const f = family.data;
    if (!f) return;
    // Family member: contact and address come from the relative (docs/10 §2); name stays blank.
    for (const [k, v] of Object.entries({
      mobile: f.mobile ?? '',
      addressLine: f.addressLine ?? '',
      localityName: f.localityName ?? '',
      district: f.district ?? '',
      state: f.state ?? '',
      pincode: f.pincode ?? '',
      lastName: f.lastName ?? '',
    })) {
      setValue(k, v);
    }
    setValue('noMobile', f.mobile ? '' : '1');
  }, [family.data, setValue]);

  useEffect(() => {
    const d = defaults.data;
    if (!d || familyOf) return;
    if (!form.getValues('district')) setValue('district', d.district ?? '');
    if (!form.getValues('state')) setValue('state', d.state ?? '');
  }, [defaults.data, familyOf, form, setValue]);

  // --- derived hints
  const [firstName, middleName, lastName, age, dob, mobile, localityName, noMobileTick, hiTouched] =
    useWatch({
      control,
      name: [
        'firstName',
        'middleName',
        'lastName',
        'age',
        'dob',
        'mobile',
        'localityName',
        'noMobile',
        'nameHiTouched',
      ],
    });
  const noMobile = noMobileTick === '1';

  // Hindi name: suggested from the English one until the receptionist types their own.
  useEffect(() => {
    if (hiTouched) return;
    const s = transliterateToDevanagari(
      joinName({ firstName: firstName ?? '', middleName, lastName }),
    );
    setValue('nameHi', s);
  }, [firstName, middleName, lastName, hiTouched, setValue]);

  const ageHint = useMemo(() => {
    if (age) {
      const r = resolveDob({ age }, istToday());
      return r ? t('hints.ageEstimated', { date: formatDate(r.dob) }) : null;
    }
    if (dob) {
      const r = resolveDob({ dob }, istToday());
      return r ? t('hints.dobAge', { age: ageText(r.dob) }) : null;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [age, dob, t]);

  const debouncedMobile = useDebounced(mobile ?? '', 300);
  const sameMobile = useQuery(
    trpc.patients.search.queryOptions(
      !edit && /^[6-9]\d{9}$/.test(debouncedMobile) ? { q: debouncedMobile } : skipToken,
    ),
  );
  const debouncedLocality = useDebounced(localityName ?? '', 200);
  const localities = useQuery(
    trpc.patients.localities.queryOptions(
      debouncedLocality.trim().length >= 2 ? { q: debouncedLocality } : skipToken,
    ),
  );

  // --- save
  const save = useMutation(
    trpc.patients.create.mutationOptions({
      onSuccess: (out) => {
        if (out.status === 'created') {
          router.push(`/reception/patients/${out.id}?registered=1`);
        } else {
          setMatches(out.matches);
          setOverriding(false);
        }
      },
      onError: (e) => setError(errorText(e)),
    }),
  );
  const update = useMutation(
    trpc.patients.update.mutationOptions({
      onSuccess: (out) => router.push(`/reception/patients/${out.id}`),
      onError: (e) => setError(errorText(e)),
    }),
  );
  const busy = save.isPending || update.isPending;

  const submit = handleSubmit((values) => {
    setError(null);
    const input = prune(values);
    if (edit && patientId) update.mutate({ ...input, id: patientId });
    else save.mutate(input);
  });

  const createAnyway = () => {
    if (reason.trim().length < 3) {
      setReasonError(true);
      return;
    }
    setError(null);
    save.mutate({
      ...prune(form.getValues()),
      duplicateOverride: { reason: reason.trim() },
    });
    setMatches(null);
  };

  useShortcut(
    'Escape',
    () => router.push(patientId ? `/reception/patients/${patientId}` : '/reception'),
    !matches,
  );

  const back = patientId ? `/reception/patients/${patientId}` : '/reception';
  const loading = (edit && existing.isPending) || (Boolean(familyOf) && family.isPending);

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-4xl space-y-6" noValidate>
      <Button asChild variant="ghost" className="-ml-3">
        <Link href={back}>
          <ArrowLeft aria-hidden />
          {t('back')}
          <ShortcutHint keys="Esc" />
        </Link>
      </Button>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{edit ? t('titleEdit') : t('titleNew')}</h1>
        <p className="max-w-3xl text-muted-foreground">
          {edit
            ? t('helpEdit')
            : family.data
              ? t('helpFamily', { name: family.data.fullName })
              : t('helpNew')}
        </p>
      </div>

      {loading ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy="true" />
      ) : edit && existing.isError ? (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-destructive">
          {t('loadFailed')}
        </p>
      ) : (
        <>
          <Section title={t('sections.required')}>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                label={t('fields.firstName')}
                autoFocus
                autoComplete="off"
                error={err('firstName')}
                {...register('firstName')}
              />
              <TextField
                label={t('fields.middleName')}
                autoComplete="off"
                error={err('middleName')}
                {...register('middleName')}
              />
              <TextField
                label={t('fields.lastName')}
                autoComplete="off"
                error={err('lastName')}
                {...register('lastName')}
              />
            </div>
            <TextField
              label={t('fields.nameHi')}
              lang="hi"
              help={t('hints.nameHiSuggestion')}
              error={err('nameHi')}
              {...register('nameHi', { onChange: () => setValue('nameHiTouched', '1') })}
            />

            <fieldset className="space-y-2">
              <legend className="text-base font-medium">{t('fields.sex')}</legend>
              <div className="flex flex-wrap gap-3">
                {PATIENT_SEXES.map((s) => (
                  <label
                    key={s}
                    className="flex min-h-11 min-w-28 cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-input bg-card px-4 text-base font-medium has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-[3px] has-focus-visible:ring-ring/60"
                  >
                    <input type="radio" value={s} className="sr-only" {...register('sex')} />
                    {tSex(s)}
                  </label>
                ))}
              </div>
              {err('sex') && (
                <FieldMessage role="alert">{fieldError('validation.required')}</FieldMessage>
              )}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('fields.age')}
                inputMode="text"
                autoComplete="off"
                help={ageHint ?? t('hints.age')}
                error={err('age')}
                {...register('age', { onChange: () => setValue('dob', '') })}
              />
              <TextField
                label={t('fields.dob')}
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                help={
                  edit && existing.data?.dobIsEstimated && dob === existing.data.dob
                    ? t('hints.keepEstimated')
                    : t('hints.dobOr')
                }
                error={err('dob')}
                {...register('dob', { onChange: () => setValue('age', '') })}
              />
            </div>
          </Section>

          <Section title={t('sections.contact')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('fields.mobile')}
                type="tel"
                inputMode="numeric"
                maxLength={14}
                autoComplete="off"
                disabled={noMobile}
                help={t('hints.mobile')}
                error={noMobile ? undefined : err('mobile')}
                {...register('mobile')}
              />
              <TextField
                label={t('fields.altMobile')}
                type="tel"
                inputMode="numeric"
                maxLength={14}
                autoComplete="off"
                error={err('altMobile')}
                {...register('altMobile')}
              />
            </div>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-base">
              <Checkbox
                checked={noMobile}
                onChange={(e) => {
                  setValue('noMobile', e.target.checked ? '1' : '');
                  if (e.target.checked) setValue('mobile', '');
                  else setValue('noMobileReason', '');
                }}
              />
              {t('fields.noMobile')}
            </label>
            {noMobile && (
              <TextField
                label={t('fields.noMobileReason')}
                error={err('mobile')}
                {...register('noMobileReason')}
              />
            )}
            {sameMobile.data && sameMobile.data.rows.length > 0 && (
              <div className="space-y-2 rounded-lg border-2 border-primary p-4" role="status">
                <p className="font-semibold">{t('sameMobile.title')}</p>
                <p className="text-muted-foreground">{t('sameMobile.hint')}</p>
                <ul className="space-y-1">
                  {sameMobile.data.rows.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-3">
                      <span className="font-medium">{r.fullName}</span>
                      <span className="text-muted-foreground tabular-nums">{r.uhid}</span>
                      <Link
                        href={`/reception/patients/${r.id}`}
                        className="rounded px-1 underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60"
                      >
                        {t('sameMobile.open')}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <details open={edit || Boolean(familyOf)} className="rounded-lg border bg-card p-5">
            <summary className="min-h-11 cursor-pointer text-xl font-semibold">
              {t('sections.more')}
            </summary>
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label={t('fields.guardianName')}
                  autoComplete="off"
                  error={err('guardianName')}
                  {...register('guardianName')}
                />
                <SelectField
                  label={t('fields.guardianRelation')}
                  placeholder={t('choose')}
                  options={GUARDIAN_RELATIONS.map((v) => ({
                    value: v,
                    label: tEnum(`guardianRelation.${v}`),
                  }))}
                  error={err('guardianRelation')}
                  {...register('guardianRelation')}
                />
                <SelectField
                  label={t('fields.relationToMobileOwner')}
                  placeholder={t('choose')}
                  options={MOBILE_OWNER_RELATIONS.map((v) => ({
                    value: v,
                    label: tEnum(`relationToMobileOwner.${v}`),
                  }))}
                  error={err('relationToMobileOwner')}
                  {...register('relationToMobileOwner')}
                />
                <SelectField
                  label={t('fields.maritalStatus')}
                  placeholder={t('choose')}
                  options={MARITAL_STATUSES.map((v) => ({
                    value: v,
                    label: tEnum(`maritalStatus.${v}`),
                  }))}
                  error={err('maritalStatus')}
                  {...register('maritalStatus')}
                />
              </div>
              <TextField
                label={t('fields.addressLine')}
                autoComplete="off"
                error={err('addressLine')}
                {...register('addressLine')}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <TextField
                    label={t('fields.localityName')}
                    list="locality-options"
                    autoComplete="off"
                    error={err('localityName')}
                    {...register('localityName')}
                  />
                  <datalist id="locality-options">
                    {(localities.data ?? []).map((l) => (
                      <option key={l.id} value={l.name} />
                    ))}
                  </datalist>
                </div>
                <TextField
                  label={t('fields.district')}
                  error={err('district')}
                  {...register('district')}
                />
                <TextField label={t('fields.state')} error={err('state')} {...register('state')} />
                <TextField
                  label={t('fields.pincode')}
                  inputMode="numeric"
                  maxLength={6}
                  error={err('pincode')}
                  {...register('pincode')}
                />
                <SelectField
                  label={t('fields.bloodGroup')}
                  placeholder={t('choose')}
                  options={BLOOD_GROUPS.map((v) => ({ value: v, label: v }))}
                  error={err('bloodGroup')}
                  {...register('bloodGroup')}
                />
                <TextField
                  label={t('fields.occupation')}
                  error={err('occupation')}
                  {...register('occupation')}
                />
                <TextField
                  label={t('fields.referredBy')}
                  error={err('referredBy')}
                  {...register('referredBy')}
                />
              </div>
            </div>
          </details>

          <FormStatus error={error} />
          <div className="flex justify-end gap-3">
            <Button asChild variant="outline">
              <Link href={back}>{tCommon('cancel')}</Link>
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('saving') : t('save')}
            </Button>
          </div>
        </>
      )}

      <Dialog
        open={matches !== null}
        onOpenChange={(o) => !o && (setMatches(null), setOverriding(false))}
      >
        <DialogContent
          closeLabel={tCommon('cancel')}
          onOpenAutoFocus={(e) => {
            // "Use this patient" is the default action (docs/10 §3).
            e.preventDefault();
            useThis.current?.focus();
          }}
        >
          <DialogTitle>{t('duplicate.title')}</DialogTitle>
          <DialogDescription>{t('duplicate.intro')}</DialogDescription>
          <ul className="space-y-3">
            {(matches ?? []).map((m, i) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 p-3"
              >
                <div className="min-w-0">
                  <p className="text-lg font-semibold">{m.fullName}</p>
                  <p className="text-muted-foreground tabular-nums">
                    {m.uhid} · {ageText(m.dob)} / {tSex(m.sex as 'F' | 'M' | 'O')}
                    {m.guardianName ? ` · ${m.guardianName}` : ''}
                    {m.localityName ? ` · ${m.localityName}` : ''}
                  </p>
                </div>
                <Link
                  ref={i === 0 ? useThis : undefined}
                  href={`/reception/patients/${m.id}`}
                  className={buttonVariants()}
                >
                  {t('duplicate.use')}
                </Link>
              </li>
            ))}
          </ul>
          {overriding ? (
            <div className="space-y-2">
              <Label htmlFor="override-reason">{t('duplicate.reason')}</Label>
              <textarea
                id="override-reason"
                rows={2}
                value={reason}
                onChange={(e) => (setReason(e.target.value), setReasonError(false))}
                aria-invalid={reasonError || undefined}
                className={cn(
                  'w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
                  reasonError && 'border-destructive',
                )}
              />
              <p
                className={cn(
                  'text-sm',
                  reasonError ? 'font-medium text-destructive' : 'text-muted-foreground',
                )}
              >
                {reasonError
                  ? fieldError('validation.patient.overrideReasonRequired')
                  : t('duplicate.reasonHint')}
              </p>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setOverriding(false)}>
                  {t('duplicate.back')}
                </Button>
                <Button type="button" onClick={createAnyway} disabled={busy}>
                  {t('duplicate.confirmCreate')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => setOverriding(true)}>
                {t('duplicate.createAnyway')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </form>
  );
}
