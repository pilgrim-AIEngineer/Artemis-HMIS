'use client';

import { formatDateTime, IMPORT_KINDS, type ImportKind } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC, useTRPCClient } from '@/trpc/client';
import { fileToBase64, saveBase64 } from './import-files';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** MIG-01 start screen: pick what to import, get the template, upload, then review the dry run. */
export function ImportStart() {
  const t = useTranslations('import');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const router = useRouter();
  const recent = useQuery(trpc.importer.list.queryOptions());
  const [kind, setKind] = useState<ImportKind>('patients');
  const [file, setFile] = useState<File | null>(null);
  const [allowMissingMobile, setAllowMissingMobile] = useState(false);
  const [duplicates, setDuplicates] = useState<'skip' | 'import'>('skip');
  const [defaultDate, setDefaultDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downloadTemplate() {
    setError(null);
    try {
      const tpl = await client.importer.template.query({ kind });
      saveBase64(tpl.base64, tpl.fileName, XLSX);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function upload() {
    if (!file) {
      setError(t('noFile'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { batchId } = await client.importer.upload.mutate({
        kind,
        fileName: file.name,
        base64: await fileToBase64(file),
        options:
          kind === 'patients'
            ? { allowMissingMobile, duplicates }
            : { defaultEffectiveFrom: defaultDate || null },
      });
      router.push(`/admin/import/${batchId}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('help')}</p>
      </div>

      <section className="max-w-2xl space-y-5 rounded-lg border bg-card p-5">
        <div className="space-y-2">
          <Label htmlFor="import-kind">{t('kind.label')}</Label>
          <Select
            id="import-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ImportKind)}
          >
            {IMPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </Select>
          <Button type="button" variant="outline" onClick={() => void downloadTemplate()}>
            <Download aria-hidden /> {t('template')}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-file">{t('file')}</Label>
          <Input
            id="import-file"
            type="file"
            accept=".xlsx,.csv,.tsv,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="text-sm text-muted-foreground">{t('fileHelp')}</p>
        </div>

        <fieldset className="space-y-3">
          <legend className="font-medium">{t('options.title')}</legend>
          {kind === 'patients' ? (
            <>
              <label className="flex items-center gap-3">
                <Checkbox
                  checked={allowMissingMobile}
                  onChange={(e) => setAllowMissingMobile(e.target.checked)}
                />
                {t('options.allowMissingMobile')}
              </label>
              <div className="space-y-2">
                <Label htmlFor="import-dups">{t('options.duplicates')}</Label>
                <Select
                  id="import-dups"
                  value={duplicates}
                  onChange={(e) => setDuplicates(e.target.value as 'skip' | 'import')}
                >
                  <option value="skip">{t('options.duplicatesSkip')}</option>
                  <option value="import">{t('options.duplicatesImport')}</option>
                </Select>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="import-date">{t('options.defaultEffectiveFrom')}</Label>
              <Input
                id="import-date"
                type="date"
                value={defaultDate}
                onChange={(e) => setDefaultDate(e.target.value)}
              />
            </div>
          )}
        </fieldset>

        <FormStatus error={error} />
        <Button type="button" onClick={() => void upload()} disabled={busy}>
          <Upload aria-hidden /> {busy ? t('checking') : t('check')}
        </Button>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{t('recent')}</h2>
        {recent.data && recent.data.length === 0 && (
          <p className="text-muted-foreground">{t('recentEmpty')}</p>
        )}
        <ul className="divide-y rounded-lg border bg-card">
          {recent.data?.map((b) => (
            <li key={b.id}>
              <Link
                href={`/admin/import/${b.id}`}
                className="flex flex-wrap items-center justify-between gap-2 p-4 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/60"
              >
                <span className="font-medium">
                  {b.fileName}{' '}
                  <span className="font-normal text-muted-foreground">
                    · {t(`kind.${b.kind as ImportKind}`)} · {t('rowsCount', { count: b.totalRows })}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {t(`stage.${b.stage as 'dry_run' | 'committing' | 'committed' | 'cancelled'}`)} ·{' '}
                  {formatDateTime(b.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
