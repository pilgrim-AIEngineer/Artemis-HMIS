'use client';

import { parseVisitQr, uuidSchema } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { NotebookPen, Pencil, ScanLine } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useAgeText } from '@/lib/use-age-text';
import { useLiveQueue } from '@/lib/use-live-queue';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';

type List = inferRouterOutputs<AppRouter>['rx']['list'];
type Item = List['toTranscribe'][number];

/**
 * The OPD sheet's QR (`E:<encounter id>`) typed by a 2D scanner in keyboard-wedge mode, then
 * Enter (docs/11 §2.1). A bare encounter id is accepted too. Opens that visit's Rx screen.
 */
export function ScanToOpen({ autoFocus = false }: { autoFocus?: boolean }) {
  const t = useTranslations('rx');
  const router = useRouter();
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const open = () => {
    const raw = text.trim();
    const id = parseVisitQr(raw) ?? (uuidSchema.safeParse(raw).success ? raw : null);
    if (!id) {
      setBad(true);
      return;
    }
    setText('');
    router.push(`/assistant/rx/${id}`);
  };
  return (
    <form
      className="max-w-2xl space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        open();
      }}
    >
      <label htmlFor="rx-scan" className="flex items-center gap-2 text-lg font-medium">
        <ScanLine aria-hidden className="size-6" />
        {t('scan.label')}
      </label>
      <Input
        id="rx-scan"
        autoFocus={autoFocus}
        autoComplete="off"
        value={text}
        aria-invalid={bad || undefined}
        aria-describedby="rx-scan-hint"
        placeholder={t('scan.placeholder')}
        className="min-h-14 text-xl"
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
      />
      <p
        id="rx-scan-hint"
        className={bad ? 'font-medium text-destructive' : 'text-muted-foreground'}
      >
        {bad ? t('scan.bad') : t('scan.hint')}
      </p>
    </form>
  );
}

/**
 * Assistant's transcription list (OPD-02, docs/11 §2.1): scan the sheet, or pick from "Seen — to
 * transcribe" (oldest first). Today's typed Rx stay below for corrections. Live with the queue.
 */
export function TranscriptionList() {
  const t = useTranslations('rx');
  const tQ = useTranslations('queue');
  const ageText = useAgeText();
  const locale = useLocale();
  const trpc = useTRPC();
  const { refetchInterval } = useLiveQueue();
  const list = useQuery(trpc.rx.list.queryOptions(undefined, { refetchInterval }));

  const row = (i: Item, done: boolean) => (
    <li
      key={i.encounterId}
      data-state={i.queueState}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border-2 bg-card p-4"
    >
      <p className="w-20 text-3xl font-semibold tabular-nums">{i.tokenNo}</p>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold">
          {locale === 'hi' && i.nameHi ? i.nameHi : i.fullName}
        </p>
        <p className="text-muted-foreground">
          {ageText(i.dob)} / {tQ(`sex.${i.sex as 'F' | 'M' | 'O'}`)} · {i.uhid} ·{' '}
          {locale === 'hi' && i.doctor.displayNameHi
            ? i.doctor.displayNameHi
            : i.doctor.displayName}
        </p>
      </div>
      {i.rx && (
        <span className="rounded-full border-2 border-money px-3 py-1 text-sm font-semibold text-money">
          {i.rx.version > 1 ? t('list.corrected', { version: i.rx.version }) : t('list.typed')}
          {i.rx.needsVerification && i.rx.status === 'final' && ` · ${t('list.toVerify')}`}
        </span>
      )}
      <Button asChild size="lg" variant={done ? 'outline' : 'default'}>
        <Link href={`/assistant/rx/${i.encounterId}`}>
          {done ? <Pencil aria-hidden /> : <NotebookPen aria-hidden />}
          {done ? t('list.edit') : t('list.open')}
        </Link>
      </Button>
    </li>
  );

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('list.title')}</h1>
        <p className="text-lg text-muted-foreground">{t('list.hint')}</p>
      </div>
      <ScanToOpen autoFocus />

      {list.isError && (
        <p role="alert" className="rounded-lg border-2 border-destructive p-4 text-lg">
          {t('loadFailed')}
        </p>
      )}

      <section aria-labelledby="rx-todo" className="space-y-3">
        <h2 id="rx-todo" className="text-2xl font-semibold">
          {t('list.toTranscribe')}
          {list.data && (
            <span className="ml-2 text-muted-foreground">({list.data.toTranscribe.length})</span>
          )}
        </h2>
        {list.data && list.data.toTranscribe.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
            {t('list.nobody')}
          </p>
        ) : (
          <ul className="space-y-3" data-testid="rx-todo">
            {list.data?.toTranscribe.map((i) => row(i, false))}
          </ul>
        )}
      </section>

      {list.data && list.data.transcribed.length > 0 && (
        <section aria-labelledby="rx-done" className="space-y-3">
          <h2 id="rx-done" className="text-2xl font-semibold">
            {t('list.transcribed')}
          </h2>
          <ul className="space-y-3" data-testid="rx-done">
            {list.data.transcribed.map((i) => row(i, true))}
          </ul>
        </section>
      )}
    </div>
  );
}
