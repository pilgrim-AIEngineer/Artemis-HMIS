'use client';

import {
  accentColorSchema,
  printHeaderSchema,
  readableOn,
  type PrintHeaderSettings,
} from '@hmis/shared';
import {
  L,
  PAPER_SIZES,
  PrintHeader,
  printCss,
  sampleTemplateKey,
  type PaperSize,
  type PrintHeaderData,
} from '@hmis/print';
import { Button } from '@hmis/ui/components/button';
import { Label } from '@hmis/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { FormStatus, TextField } from '@/components/form/text-field';
import { Section } from '@/components/section';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useErrorText } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';

const NEUTRAL_ACCENT = '#000000';

type Fields = Record<keyof PrintHeaderSettings, string | boolean>;

/** Admin → Print header: Hindi lines, footer note, brand colour, with a live preview and test prints. */
export function PrintSettings() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const settings = useQuery(trpc.admin.listSettings.queryOptions());
  const facility = useQuery(trpc.admin.getFacility.queryOptions());
  useShortcut('Escape', () => router.push('/admin'));

  const header = settings.data?.items.find((i) => i.key === 'print.header')?.value;
  const accent = settings.data?.items.find((i) => i.key === 'ui.accentColor')?.value;

  if (settings.isPending || facility.isPending || !facility.data) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy="true" />;
  }
  return (
    <PrintSettingsForm
      key={facility.data.facilityId}
      initialHeader={printHeaderSchema.parse(header ?? {})}
      initialAccent={typeof accent === 'string' ? accent : null}
      facility={facility.data}
      onSaved={async () => {
        await qc.invalidateQueries({ queryKey: trpc.admin.listSettings.queryKey() });
        router.refresh();
      }}
    />
  );
}

function PrintSettingsForm({
  initialHeader,
  initialAccent,
  facility,
  onSaved,
}: {
  initialHeader: PrintHeaderSettings;
  initialAccent: string | null;
  facility: {
    facilityId: string;
    name: string;
    address: string | null;
    district: string | null;
    state: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
    gstin: string | null;
    clinicalEstablishmentRegNo: string | null;
  };
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('admin.print');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [fields, setFields] = useState<Fields>({ ...initialHeader });
  const [accent, setAccent] = useState<string | null>(initialAccent);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [previewPaper, setPreviewPaper] = useState<PaperSize>('a5');

  const set = (k: keyof PrintHeaderSettings, v: string | boolean) => {
    setFields((f) => ({ ...f, [k]: v }));
    setDone(null);
  };
  const text = (k: keyof PrintHeaderSettings) => String(fields[k]);

  const parsedHeader = printHeaderSchema.safeParse(fields);
  const accentOk = accent === null || accentColorSchema.safeParse(accent).success;

  const saveHeader = useMutation(trpc.admin.updateSetting.mutationOptions());
  const saveAccent = useMutation(trpc.admin.updateSetting.mutationOptions());
  const saving = saveHeader.isPending || saveAccent.isPending;
  const save = async () => {
    if (!parsedHeader.success || !accentOk) return;
    try {
      await saveHeader.mutateAsync({ key: 'print.header', value: parsedHeader.data });
      await saveAccent.mutateAsync({
        key: 'ui.accentColor',
        value: accent === null ? null : accentColorSchema.parse(accent),
      });
      setError(null);
      setDone(t('saved'));
      await onSaved();
    } catch (e) {
      setDone(null);
      setError(errorText(e));
    }
  };

  const preview: PrintHeaderData = useMemo(
    () => ({
      nameEn: facility.name,
      nameHi: text('nameHi'),
      taglineEn: text('taglineEn'),
      taglineHi: text('taglineHi'),
      addressEn: [facility.address, facility.district, facility.state, facility.pincode]
        .filter(Boolean)
        .join(', '),
      addressHi: text('addressHi'),
      phone: facility.phone ?? '',
      email: facility.email ?? '',
      registrationNos:
        fields.showRegistrationNos === true
          ? [
              ...(facility.clinicalEstablishmentRegNo
                ? [
                    {
                      label: L.clinicalEstablishmentRegNo,
                      value: facility.clinicalEstablishmentRegNo,
                    },
                  ]
                : []),
              ...(facility.gstin ? [{ label: L.gstin, value: facility.gstin }] : []),
            ]
          : [],
      footerNoteEn: text('footerNoteEn'),
      footerNoteHi: text('footerNoteHi'),
      accent: accentOk ? accent : null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, accent, accentOk, facility],
  );

  return (
    <form
      className="max-w-5xl space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
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

      <Section title={t('sections.header')} help={t('headerHelp')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('fields.nameHi')}
            lang="hi"
            autoFocus
            value={text('nameHi')}
            onChange={(e) => set('nameHi', e.target.value)}
          />
          <TextField
            label={t('fields.addressHi')}
            lang="hi"
            value={text('addressHi')}
            onChange={(e) => set('addressHi', e.target.value)}
          />
          <TextField
            label={t('fields.taglineHi')}
            lang="hi"
            value={text('taglineHi')}
            onChange={(e) => set('taglineHi', e.target.value)}
          />
          <TextField
            label={t('fields.taglineEn')}
            value={text('taglineEn')}
            onChange={(e) => set('taglineEn', e.target.value)}
          />
          <TextField
            label={t('fields.footerNoteHi')}
            lang="hi"
            value={text('footerNoteHi')}
            onChange={(e) => set('footerNoteHi', e.target.value)}
          />
          <TextField
            label={t('fields.footerNoteEn')}
            value={text('footerNoteEn')}
            onChange={(e) => set('footerNoteEn', e.target.value)}
          />
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="size-6 accent-[var(--primary)]"
            checked={fields.showRegistrationNos === true}
            onChange={(e) => set('showRegistrationNos', e.target.checked)}
          />
          {t('fields.showRegistrationNos')}
        </label>
        <p className="text-sm text-muted-foreground">
          {t('profileNote')}{' '}
          <Link className="font-medium text-primary underline" href="/admin/facility">
            {t('profileLink')}
          </Link>
        </p>
      </Section>

      <Section title={t('sections.colour')} help={t('colourHelp')}>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-2">
            <Label htmlFor="accent-picker">{t('fields.accent')}</Label>
            <input
              id="accent-picker"
              type="color"
              className="h-11 w-20 cursor-pointer rounded-md border-2 border-input bg-card p-1"
              value={accent && accentOk ? accent : NEUTRAL_ACCENT}
              onChange={(e) => {
                setAccent(e.target.value);
                setDone(null);
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAccent(null)}
            disabled={accent === null}
          >
            {t('neutral')}
          </Button>
          {accent && accentOk && (
            <span
              className="inline-flex min-h-11 items-center rounded-md px-4 font-medium"
              style={{ backgroundColor: accent, color: readableOn(accent) }}
            >
              {t('buttonSample')}
            </span>
          )}
        </div>
      </Section>

      <Section title={t('sections.preview')}>
        <div role="group" aria-label={t('paper')} className="flex flex-wrap gap-2">
          {(Object.keys(PAPER_SIZES) as PaperSize[])
            .filter((p) => p !== 'label50x25')
            .map((p) => (
              <Button
                key={p}
                type="button"
                variant={p === previewPaper ? 'secondary' : 'ghost'}
                aria-pressed={p === previewPaper}
                onClick={() => setPreviewPaper(p)}
              >
                {t(`papers.${p}`)}
              </Button>
            ))}
        </div>
        <div className="overflow-x-auto rounded-md border" data-testid="header-preview">
          <div
            className={`print-root print-paper-${previewPaper}`}
            style={
              preview.accent
                ? ({ '--print-accent': preview.accent } as React.CSSProperties)
                : undefined
            }
          >
            <style
              dangerouslySetInnerHTML={{
                __html: printCss(previewPaper).replace(/@page[^}]*}/, ''),
              }}
            />
            <div className="print-sheet" style={{ minHeight: 0 }}>
              <PrintHeader header={preview} paper={previewPaper} />
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('sections.testPrints')} help={t('testPrintsHelp')}>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(PAPER_SIZES) as PaperSize[]).map((p) => (
            <li key={p}>
              <Button asChild variant="outline" className="w-full">
                <Link
                  prefetch={false}
                  href={`/print/${sampleTemplateKey(p)}/${facility.facilityId}`}
                >
                  {t(`papers.${p}`)}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || !parsedHeader.success || !accentOk}>
          {t('save')}
        </Button>
        <FormStatus error={error} success={done} />
      </div>
    </form>
  );
}
