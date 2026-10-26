'use client';

import {
  DRUG_FORMS,
  DURATION_UNITS,
  FREQUENCY_CODES,
  parseRxShorthand,
  RX_ROUTES,
  RX_TIMINGS,
  type DrugForm,
  type RxPhrasesOverride,
  type RxWarning,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { DrugPicker, type DrugPickerOption } from '@hmis/ui/components/drug-picker';
import { Input } from '@hmis/ui/components/input';
import { cn } from '@hmis/ui/lib/utils';
import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { CornerDownLeft, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { WarningText } from './warning-text';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useDebounced } from '@/lib/use-debounced';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import {
  drugLabel,
  rowFromParsed,
  shownInstruction,
  shownQuantity,
  type DrugChoice,
  type RxRow,
} from './rx-state';

type Hit = inferRouterOutputs<AppRouter>['rx']['searchDrugs'][number];
type RxT = ReturnType<typeof useTranslations<'rx'>>;

/** One empty list, so "no results" keeps its identity between renders. */
const NO_HITS: Hit[] = [];

const selectClass =
  'min-h-11 w-full rounded-md border-2 border-input bg-background px-2 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60';

/** The drug search behind a typed name (debounced, previous results kept while typing). */
function useDrugSearch(encounterId: string, text: string, form: DrugForm | null) {
  const trpc = useTRPC();
  const q = useDebounced(text.trim(), 200);
  const query = useQuery(
    trpc.rx.searchDrugs.queryOptions(q.length >= 2 ? { encounterId, q, form } : skipToken, {
      placeholderData: keepPreviousData,
      staleTime: 60_000,
    }),
  );
  // Results belong to the text on screen only once the debounce caught up and the fetch landed.
  const settled = q === text.trim() && !query.isFetching;
  const hits = q.length >= 2 ? (query.data ?? NO_HITS) : NO_HITS;
  return { hits, settled, loading: query.isFetching };
}

const toChoice = (h: Hit): DrugChoice => ({
  id: h.id,
  brandName: h.brandName,
  genericName: h.genericName,
  strength: h.strength,
  form: h.form,
});

function hitOption(t: RxT, h: Hit): DrugPickerOption {
  return {
    id: h.id,
    label: drugLabel(h),
    detail: [h.genericName !== h.brandName ? h.genericName : null, t(`forms.${h.form}`)]
      .filter(Boolean)
      .join(' · '),
    badge: h.uses > 0 ? t('med.oftenUsed') : !h.isStocked ? t('med.notStocked') : null,
  };
}

/**
 * The shorthand line (docs/11 §2.3): typed, parsed as you type, matched to the drug master; the
 * parsed row is shown for confirmation and Enter adds it. ↑/↓ choose another match (the last
 * choice is "as typed"). Pressing Enter before the lookup has landed waits for it, so a fast
 * typist never gets a free-text row by accident.
 */
export function ShorthandEntry({
  encounterId,
  line,
  onLineChange,
  onAdd,
  phrases,
  inputRef,
  disabled,
}: {
  encounterId: string;
  line: string;
  onLineChange: (v: string) => void;
  onAdd: (r: RxRow) => void;
  phrases: RxPhrasesOverride;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  const t = useTranslations('rx');
  const parsed = useMemo(() => parseRxShorthand(line), [line]);
  const { hits, settled, loading } = useDrugSearch(encounterId, parsed.drugText, parsed.form);
  const [pick, setPick] = useState(0);
  const [waiting, setWaiting] = useState(false);
  // A new result list starts at its best match (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(hits);
  if (seen !== hits) {
    setSeen(hits);
    setPick(0);
  }
  const choice = pick < hits.length ? hits[pick]! : null;
  const preview = line.trim() ? rowFromParsed(parsed, choice ? toChoice(choice) : null) : null;

  const accept = () => {
    if (!preview) return;
    onAdd(preview);
    onLineChange('');
    setWaiting(false);
  };
  useEffect(() => {
    if (!waiting || !settled) return;
    // Enter was pressed while the lookup ran: add the row as soon as it has landed.
    const id = setTimeout(accept, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `accept` reads the settled state
  }, [waiting, settled]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!line.trim()) return;
      if (parsed.drugText.length >= 2 && !settled) setWaiting(true);
      else accept();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPick((p) => Math.min(p + 1, hits.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPick((p) => Math.max(p - 1, 0));
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="rx-line" className="text-lg font-medium">
          {t('med.lineLabel')}
        </label>
        <div className="flex gap-2">
          <Input
            id="rx-line"
            ref={inputRef}
            value={line}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('med.linePlaceholder')}
            aria-describedby="rx-line-hint"
            className="min-h-14 font-mono text-xl"
            onChange={(e) => onLineChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={disabled || !preview}
            onClick={() => (parsed.drugText.length >= 2 && !settled ? setWaiting(true) : accept())}
          >
            <CornerDownLeft aria-hidden />
            {t('med.add')}
          </Button>
        </div>
        <p id="rx-line-hint" className="text-muted-foreground">
          {t('med.lineHint')}
        </p>
      </div>

      {preview && (
        <div
          aria-live="polite"
          data-testid="rx-preview"
          className="space-y-2 rounded-lg border-2 border-primary/40 bg-card p-3"
        >
          <p className="text-sm font-medium text-muted-foreground">
            {waiting || loading ? t('med.searching') : t('med.previewTitle')}
          </p>
          <p className="text-xl font-semibold" data-testid="rx-preview-drug">
            {preview.drugName}
            {!choice && preview.drugName && (
              <span className="ml-2 text-base font-normal text-amber-900">
                ({t('med.asTyped')})
              </span>
            )}
          </p>
          <p className="text-lg tabular-nums">
            {[
              preview.doseText,
              preview.pattern,
              preview.frequencyCode && !preview.pattern
                ? t(`codes.${preview.frequencyCode}`)
                : null,
              preview.timing ? t(`timings.${preview.timing}`) : null,
              preview.route ? t(`routes.${preview.route}`) : null,
              preview.durationValue && preview.durationUnit
                ? t(`durations.${preview.durationUnit}`, { n: preview.durationValue })
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || t('med.nothingParsed')}
            {shownQuantity(preview) !== null && (
              <span className="ml-3 font-semibold">
                {t('med.qtyShort', { n: shownQuantity(preview)! })}
              </span>
            )}
          </p>
          <p className="text-lg" lang="hi">
            {shownInstruction(preview, 'hi', phrases)}
          </p>
          {hits.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label={t('med.matches')}>
              {[...hits.slice(0, 5), null].map((h, i) => (
                <li key={h?.id ?? 'typed'}>
                  <button
                    type="button"
                    aria-pressed={i === pick}
                    onClick={() => setPick(h ? i : hits.length)}
                    className={cn(
                      'min-h-11 rounded-md border-2 px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
                      (h ? i === pick : pick >= hits.length)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background',
                    )}
                  >
                    {h ? drugLabel(h) : t('med.asTyped')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The drug of a grid row: change it by searching the master again, or keep the free text. */
function RowDrug({
  encounterId,
  row,
  index,
  onChange,
}: {
  encounterId: string;
  row: RxRow;
  index: number;
  onChange: (patch: Partial<RxRow>) => void;
}) {
  const t = useTranslations('rx');
  const [text, setText] = useState(row.drugName);
  const [editing, setEditing] = useState(false);
  const { hits, loading } = useDrugSearch(encounterId, editing ? text : '', row.form);
  if (!editing && text !== row.drugName) setText(row.drugName);
  return (
    <DrugPicker
      id={`rx-drug-${row.key}`}
      value={text}
      onValueChange={(v) => {
        setText(v);
        setEditing(true);
      }}
      options={hits.map((h) => hitOption(t, h))}
      loading={loading}
      onPick={(o) => {
        const h = hits.find((x) => x.id === o.id)!;
        setEditing(false);
        onChange({
          drugId: h.id,
          drugName: drugLabel(h),
          genericName: h.genericName,
          strength: h.strength,
          form: h.form,
        });
      }}
      onFreeText={(v) => {
        setEditing(false);
        onChange({ drugId: null, drugName: v, genericName: null, strength: null });
      }}
      labels={{
        label: t('med.drugOfRow', { n: index + 1 }),
        list: t('med.matches'),
        loading: t('med.searching'),
        freeText: (v) => t('med.freeTextOption', { text: v }),
      }}
    />
  );
}

/** One row of the medicines grid: every field stays editable after the shorthand parse. */
function RowEditor({
  encounterId,
  row,
  index,
  phrases,
  warnings,
  onChange,
  onRemove,
  disabled,
}: {
  encounterId: string;
  row: RxRow;
  index: number;
  phrases: RxPhrasesOverride;
  warnings: RxWarning[];
  onChange: (patch: Partial<RxRow>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations('rx');
  const id = (f: string) => `rx-${f}-${row.key}`;
  const qty = shownQuantity(row);
  const nullable = (v: string) => (v.trim() ? v : null);
  const field = (f: string, label: string, el: React.ReactNode, wide = false) => (
    <div className={cn('space-y-1', wide && 'sm:col-span-2')}>
      <label htmlFor={id(f)} className="text-sm font-medium text-muted-foreground">
        {label}
      </label>
      {el}
    </div>
  );
  return (
    <li
      className="space-y-3 rounded-lg border-2 bg-card p-3"
      data-testid="rx-row"
      aria-label={t('med.rowLabel', { n: index + 1, drug: row.drugName })}
    >
      <div className="flex items-start gap-2">
        <span className="mt-2 w-8 text-xl font-semibold tabular-nums">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          <RowDrug encounterId={encounterId} row={row} index={index} onChange={onChange} />
          {!row.drugId && (
            <p className="mt-1 text-sm font-medium text-amber-900">{t('med.freeTextFlag')}</p>
          )}
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={disabled}
          aria-label={t('med.remove', { n: index + 1 })}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {field(
          'form',
          t('fields.form'),
          <select
            id={id('form')}
            className={selectClass}
            value={row.form ?? ''}
            onChange={(e) => onChange({ form: (e.target.value || null) as DrugForm | null })}
          >
            <option value="">—</option>
            {DRUG_FORMS.map((f) => (
              <option key={f} value={f}>
                {t(`forms.${f}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          'dose',
          t('fields.dose'),
          <Input
            id={id('dose')}
            value={row.doseText ?? ''}
            onChange={(e) => onChange({ doseText: nullable(e.target.value) })}
          />,
        )}
        {field(
          'pattern',
          t('fields.pattern'),
          <Input
            id={id('pattern')}
            value={row.pattern ?? ''}
            placeholder="1-0-1"
            className="font-mono tabular-nums"
            onChange={(e) => onChange({ pattern: nullable(e.target.value) })}
          />,
        )}
        {field(
          'code',
          t('fields.frequency'),
          <select
            id={id('code')}
            className={selectClass}
            value={row.frequencyCode ?? ''}
            onChange={(e) =>
              onChange({ frequencyCode: (e.target.value || null) as RxRow['frequencyCode'] })
            }
          >
            <option value="">—</option>
            {FREQUENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {t(`codes.${c}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          'timing',
          t('fields.timing'),
          <select
            id={id('timing')}
            className={selectClass}
            value={row.timing ?? ''}
            onChange={(e) => onChange({ timing: (e.target.value || null) as RxRow['timing'] })}
          >
            <option value="">—</option>
            {RX_TIMINGS.map((c) => (
              <option key={c} value={c}>
                {t(`timings.${c}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          'route',
          t('fields.route'),
          <select
            id={id('route')}
            className={selectClass}
            value={row.route ?? ''}
            onChange={(e) => onChange({ route: (e.target.value || null) as RxRow['route'] })}
          >
            <option value="">—</option>
            {RX_ROUTES.map((c) => (
              <option key={c} value={c}>
                {t(`routes.${c}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          'duration',
          t('fields.duration'),
          <div className="flex gap-2">
            <Input
              id={id('duration')}
              inputMode="numeric"
              className="w-20 tabular-nums"
              value={row.durationValue ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                const v = e.target.value.trim() && Number.isInteger(n) && n > 0 ? n : null;
                onChange({ durationValue: v, durationUnit: v ? (row.durationUnit ?? 'd') : null });
              }}
            />
            <select
              aria-label={t('fields.durationUnit')}
              className={selectClass}
              value={row.durationUnit ?? ''}
              disabled={!row.durationValue}
              onChange={(e) =>
                onChange({ durationUnit: (e.target.value || null) as RxRow['durationUnit'] })
              }
            >
              {DURATION_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`units.${u}`)}
                </option>
              ))}
            </select>
          </div>,
        )}
        {field(
          'qty',
          t('fields.qty'),
          <Input
            id={id('qty')}
            inputMode="decimal"
            className="tabular-nums"
            value={row.quantity ?? ''}
            placeholder={qty === null ? '—' : String(qty)}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ quantity: e.target.value.trim() && n >= 0 ? n : null });
            }}
          />,
        )}
        {field(
          'hi',
          t('fields.hindi'),
          <Input
            id={id('hi')}
            lang="hi"
            value={row.instructionsHi ?? ''}
            placeholder={shownInstruction({ ...row, instructionsHi: null }, 'hi', phrases)}
            onChange={(e) => onChange({ instructionsHi: nullable(e.target.value) })}
          />,
          true,
        )}
      </div>
      <p className="text-lg" lang="hi" data-testid="rx-row-hindi">
        {shownInstruction(row, 'hi', phrases)}
        {qty !== null && (
          <span className="ml-3 font-semibold">{t('med.qtyShort', { n: qty })}</span>
        )}
      </p>
      {warnings.length > 0 && (
        <ul className="space-y-1" data-testid="rx-row-warnings">
          {warnings.map((w) => (
            <li
              key={w.code}
              className="rounded-md border-2 border-amber-600 bg-amber-50 px-3 py-1 font-medium text-amber-950"
            >
              ▲ <WarningText warning={w} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function MedicinesGrid({
  encounterId,
  rows,
  warnings,
  phrases,
  onChange,
  disabled,
}: {
  encounterId: string;
  rows: RxRow[];
  warnings: RxWarning[];
  phrases: RxPhrasesOverride;
  onChange: (rows: RxRow[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('rx');
  const listRef = useRef<HTMLOListElement>(null);
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border-2 border-dashed p-6 text-lg text-muted-foreground">
        {t('med.empty')}
      </p>
    );
  }
  return (
    <ol ref={listRef} className="space-y-3" aria-label={t('med.listLabel')}>
      {rows.map((r, i) => (
        <RowEditor
          key={r.key}
          encounterId={encounterId}
          row={r}
          index={i}
          phrases={phrases}
          disabled={disabled}
          warnings={warnings.filter((w) => w.row === i)}
          onChange={(patch) =>
            onChange(rows.map((x) => (x.key === r.key ? { ...x, ...patch } : x)))
          }
          onRemove={() => onChange(rows.filter((x) => x.key !== r.key))}
        />
      ))}
    </ol>
  );
}
