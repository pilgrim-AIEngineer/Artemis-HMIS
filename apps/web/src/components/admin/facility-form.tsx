'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { facilityProfileSchema } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Label } from '@hmis/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormStatus, TextField } from '@/components/form/text-field';
import { Section } from '@/components/section';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useErrorText } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';

/** The form edits licence numbers one per line; the API takes a list. */
const formSchema = facilityProfileSchema.extend({ drugLicenceNos: z.string() });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

const toLines = (v: string) =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Admin → Facility profile: the name, address and registration numbers printed on every document. */
export function FacilityForm() {
  const t = useTranslations('admin.facility');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const current = useQuery(trpc.admin.getFacility.queryOptions());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', drugLicenceNos: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    const f = current.data;
    if (!f) return;
    reset({
      name: f.name,
      shortName: f.shortName ?? '',
      address: f.address ?? '',
      district: f.district ?? '',
      state: f.state ?? '',
      pincode: f.pincode ?? '',
      phone: f.phone ?? '',
      email: f.email ?? '',
      gstin: f.gstin ?? '',
      clinicalEstablishmentRegNo: f.clinicalEstablishmentRegNo ?? '',
      pcpndtRegNo: f.pcpndtRegNo ?? '',
      mtpApprovalNo: f.mtpApprovalNo ?? '',
      hfrId: f.hfrId ?? '',
      drugLicenceNos: f.drugLicenceNos.join('\n'),
    });
  }, [current.data, reset]);

  const save = useMutation(
    trpc.admin.updateFacility.mutationOptions({
      onSuccess: async () => {
        setError(null);
        setDone(t('saved'));
        await qc.invalidateQueries({ queryKey: trpc.admin.getFacility.queryKey() });
        router.refresh();
      },
      onError: (e) => {
        setDone(null);
        setError(errorText(e));
      },
    }),
  );
  const onSubmit = handleSubmit(() => {
    // Valid by the shared schema; send what was typed, the server parses it again (blank → null).
    const typed = form.getValues();
    save.mutate({ ...typed, drugLicenceNos: toLines(typed.drugLicenceNos) });
  });
  useShortcut('Escape', () => router.push('/admin'));
  /** Message key of a field's error; `TextField` turns it into plain language. */
  const err = (name: keyof FormInput) => formState.errors[name]?.message;

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="max-w-4xl space-y-6" noValidate>
      <Button asChild variant="ghost" className="-ml-3">
        <Link href="/admin">
          <ArrowLeft aria-hidden />
          {t('back')}
          <ShortcutHint keys="Esc" />
        </Link>
      </Button>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('help')}</p>
      </div>
      {current.isPending ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy="true" />
      ) : (
        <>
          <Section title={t('sections.identity')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('fields.name')}
                autoFocus
                error={err('name')}
                {...register('name')}
              />
              <TextField
                label={t('fields.shortName')}
                error={err('shortName')}
                {...register('shortName')}
              />
            </div>
          </Section>
          <Section title={t('sections.address')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <TextField
                  label={t('fields.address')}
                  error={err('address')}
                  {...register('address')}
                />
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
              <TextField
                label={t('fields.phone')}
                inputMode="tel"
                error={err('phone')}
                {...register('phone')}
              />
              <TextField
                label={t('fields.email')}
                type="email"
                error={err('email')}
                {...register('email')}
              />
            </div>
          </Section>
          <Section title={t('sections.registrations')} help={t('registrationsHelp')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('fields.clinicalEstablishmentRegNo')}
                error={err('clinicalEstablishmentRegNo')}
                {...register('clinicalEstablishmentRegNo')}
              />
              <TextField label={t('fields.gstin')} error={err('gstin')} {...register('gstin')} />
              <TextField
                label={t('fields.pcpndtRegNo')}
                error={err('pcpndtRegNo')}
                {...register('pcpndtRegNo')}
              />
              <TextField
                label={t('fields.mtpApprovalNo')}
                error={err('mtpApprovalNo')}
                {...register('mtpApprovalNo')}
              />
              <TextField label={t('fields.hfrId')} error={err('hfrId')} {...register('hfrId')} />
              <div className="space-y-2">
                <Label htmlFor="drug-licences">{t('fields.drugLicenceNos')}</Label>
                <textarea
                  id="drug-licences"
                  rows={3}
                  className="w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  {...register('drugLicenceNos')}
                />
                <p className="text-sm text-muted-foreground">{t('drugLicenceHelp')}</p>
              </div>
            </div>
          </Section>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {t('save')}
            </Button>
            <FormStatus error={error} success={done} />
          </div>
        </>
      )}
    </form>
  );
}
