'use client';

import { isGenericSetting, SETTING_GROUPS, type SettingEditor as EditorSpec } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { FieldMessage, Label } from '@hmis/ui/components/label';
import { Input } from '@hmis/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { FormStatus } from '@/components/form/text-field';
import { ShortcutHint } from '@/components/shortcut-hint';
import { useErrorText, useFieldError } from '@/lib/use-error-text';
import { useShortcut } from '@/lib/use-shortcut';
import { useTRPC } from '@/trpc/client';
import { fromDraft, sameDraft, toDraft, type Draft } from './settings-draft';

/** Message keys built from registry keys cannot be checked at compile time; a test covers them. */
type Dyn = (key: string, values?: Record<string, string | number>) => string;

interface Item {
  key: string;
  group: string;
  editor: EditorSpec;
  value: unknown;
  default: unknown;
  isDefault: boolean;
}

function Control({
  id,
  editor,
  draft,
  onChange,
  roleNames,
  describedBy,
}: {
  id: string;
  editor: EditorSpec;
  draft: Draft;
  onChange: (d: Draft) => void;
  roleNames: Record<string, { en: string; hi: string }>;
  describedBy: string;
}) {
  const t = useTranslations('admin.settings') as unknown as Dyn;
  const locale = useLocale() as 'en' | 'hi';
  switch (editor.kind) {
    case 'boolean':
      return (
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            id={id}
            type="checkbox"
            className="size-6 accent-[var(--primary)]"
            checked={draft === true}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{draft === true ? t('on') : t('off')}</span>
        </label>
      );
    case 'integer':
      return (
        <div className="flex items-center gap-2">
          {editor.paise && <span aria-hidden>₹</span>}
          <Input
            id={id}
            className="max-w-48 text-right"
            inputMode={editor.paise ? 'decimal' : 'numeric'}
            value={String(draft)}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
          />
          {(editor.min !== null || editor.max !== null) && !editor.paise && (
            <span className="text-sm text-muted-foreground">
              {t('range', { min: editor.min ?? '…', max: editor.max ?? '…' })}
            </span>
          )}
        </div>
      );
    case 'enum':
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-2">
          {editor.options.map((o) => (
            <label
              key={o}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border-2 px-3 py-2 has-[:checked]:border-primary"
            >
              <input
                type="radio"
                name={id}
                className="size-5 accent-[var(--primary)]"
                checked={draft === o}
                onChange={() => onChange(o)}
              />
              {t(`options.${o}`)}
            </label>
          ))}
        </div>
      );
    case 'text':
      return (editor.maxLength ?? 0) > 200 ? (
        <textarea
          id={id}
          rows={4}
          maxLength={editor.maxLength ?? undefined}
          className="w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={String(draft)}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          maxLength={editor.maxLength ?? undefined}
          value={String(draft)}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'enumArray': {
      const picked = Array.isArray(draft) ? draft : [];
      return (
        <div
          role="group"
          aria-labelledby={`${id}-label`}
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          {editor.options.map((o) => (
            <label
              key={o}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border-2 px-3 py-2 has-[:checked]:border-primary"
            >
              <input
                type="checkbox"
                className="size-5 accent-[var(--primary)]"
                checked={picked.includes(o)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...picked, o] : picked.filter((v) => v !== o))
                }
              />
              {roleNames[o]?.[locale] ?? o}
            </label>
          ))}
        </div>
      );
    }
    case 'lines':
    case 'json':
      return (
        <textarea
          id={id}
          rows={editor.kind === 'json' ? 8 : 4}
          spellCheck={false}
          className="w-full rounded-md border-2 border-input bg-card px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={String(draft)}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function SettingRow({
  item,
  roleNames,
}: {
  item: Item;
  roleNames: Record<string, { en: string; hi: string }>;
}) {
  const t = useTranslations('admin.settings') as unknown as Dyn;
  const errorText = useErrorText();
  const fieldError = useFieldError();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const id = useId();
  const saved = toDraft(item.editor, item.value);
  const [draft, setDraft] = useState<Draft>(saved);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dirty = !sameDraft(draft, saved);
  const parsed = fromDraft(item.editor, draft);

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.admin.listSettings.queryKey() });
  const save = useMutation(
    trpc.admin.updateSetting.mutationOptions({
      onSuccess: async (res) => {
        setError(null);
        setDone(t('saved'));
        setDraft(toDraft(item.editor, res.value));
        await refresh();
      },
      onError: (e) => {
        setDone(null);
        setError(errorText(e));
      },
    }),
  );
  const reset = useMutation(
    trpc.admin.resetSetting.mutationOptions({
      onSuccess: async () => {
        setError(null);
        setDone(t('resetDone'));
        setDraft(toDraft(item.editor, item.default));
        await refresh();
      },
      onError: (e) => setError(errorText(e)),
    }),
  );

  const label = t(`items.${item.key}.label`);
  const hintId = `${id}-hint`;
  const errId = `${id}-error`;
  const shownError = error ?? (dirty && !parsed.ok ? fieldError(parsed.error) : undefined);

  return (
    <li
      className="space-y-3 p-5"
      data-testid={`setting-${item.key}`}
      onKeyDown={(e) => {
        // Enter saves from single-line fields; textareas keep Enter for new lines.
        if (
          e.key === 'Enter' &&
          e.target instanceof HTMLInputElement &&
          e.target.type !== 'radio' &&
          dirty &&
          parsed.ok
        ) {
          e.preventDefault();
          save.mutate({ key: item.key as never, value: parsed.value });
        }
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <Label id={`${id}-label`} htmlFor={id} className="text-lg leading-snug">
            {label}
          </Label>
          <p id={hintId} className="max-w-3xl text-muted-foreground">
            {t(`items.${item.key}.hint`)}
          </p>
        </div>
        <span
          className={
            item.isDefault
              ? 'rounded bg-secondary px-2 py-0.5 text-sm font-medium'
              : 'rounded border-2 border-primary px-2 py-0.5 text-sm font-medium'
          }
        >
          {item.isDefault ? t('recommended') : t('changed')}
        </span>
      </div>
      <Control
        id={id}
        editor={item.editor}
        draft={draft}
        onChange={(d) => {
          setDraft(d);
          setDone(null);
          setError(null);
        }}
        roleNames={roleNames}
        describedBy={[hintId, shownError && errId].filter(Boolean).join(' ')}
      />
      {shownError && (
        <FieldMessage id={errId} role="alert">
          {shownError}
        </FieldMessage>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!dirty || !parsed.ok || save.isPending}
          onClick={() => parsed.ok && save.mutate({ key: item.key as never, value: parsed.value })}
        >
          {t('save')}
        </Button>
        {!item.isDefault && (
          <Button
            variant="outline"
            disabled={reset.isPending}
            onClick={() => reset.mutate({ key: item.key as never })}
          >
            {t('reset')}
          </Button>
        )}
        <FormStatus success={done} />
      </div>
    </li>
  );
}

/** Admin → Settings: every registry key with an editor derived from its zod schema (FND-06). */
export function SettingsEditor() {
  const t = useTranslations('admin.settings') as unknown as Dyn;
  const trpc = useTRPC();
  const list = useQuery(trpc.admin.listSettings.queryOptions());
  const [filter, setFilter] = useState('');

  // The list also carries dedicated keys (print.header, ui.accentColor) for their own screens.
  const items = ((list.data?.items ?? []) as Item[]).filter((i) => isGenericSetting(i.key));
  const q = filter.trim().toLowerCase();
  const shown = (key: string) =>
    !q || t(`items.${key}.label`).toLowerCase().includes(q) || key.toLowerCase().includes(q);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" className="-ml-3">
        <Link href="/admin">
          <ArrowLeft aria-hidden />
          {t('back')}
          <ShortcutHint keys="Esc" />
        </Link>
      </Button>
      <BackShortcut />
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('help')}</p>
      </div>
      <div className="max-w-md space-y-2">
        <Label htmlFor="settings-filter">{t('search')}</Label>
        <Input
          id="settings-filter"
          type="search"
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {list.isPending ? (
        <div className="h-40 animate-pulse rounded-lg bg-muted" aria-busy="true" />
      ) : (
        SETTING_GROUPS.map((g) => {
          const rows = items.filter((i) => i.group === g && shown(i.key));
          if (rows.length === 0) return null;
          return (
            <section key={g} aria-labelledby={`group-${g}`} className="space-y-3">
              <h2 id={`group-${g}`} className="text-2xl font-semibold">
                {t(`groups.${g}`)}
              </h2>
              <ul className="divide-y rounded-lg border bg-card">
                {rows.map((item) => (
                  <SettingRow key={item.key} item={item} roleNames={list.data?.roleNames ?? {}} />
                ))}
              </ul>
            </section>
          );
        })
      )}
      {!list.isPending && items.every((i) => !shown(i.key)) && (
        <p className="rounded-lg border bg-card p-6 text-lg">{t('noMatch')}</p>
      )}
    </div>
  );
}

/** `Esc`: the first press leaves the field being typed in, the next goes back to Administration. */
function BackShortcut() {
  const router = useRouter();
  useShortcut('Escape', () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(el.tagName)) {
      el.blur();
      return;
    }
    router.push('/admin');
  });
  return null;
}
