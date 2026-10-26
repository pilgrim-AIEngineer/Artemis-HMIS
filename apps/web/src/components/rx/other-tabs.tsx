'use client';

import {
  followUpDateAfter,
  FOLLOW_UP_MAX_DAYS,
  FOLLOW_UP_QUICK_DAYS,
  formatDate,
  isValidFollowUpDate,
  type OrderKind,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { cn } from '@hmis/ui/lib/utils';
import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useDebounced } from '@/lib/use-debounced';
import { useTRPC } from '@/trpc/client';
import type { RxState } from './rx-state';

const chipClass = (on: boolean) =>
  cn(
    'min-h-11 rounded-full border-2 px-4 text-base font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
    on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background',
  );

const textAreaClass =
  'min-h-24 w-full rounded-md border-2 border-input bg-background px-3 py-2 text-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60';

export interface ServiceInfo {
  id: string;
  name: string;
  kind: OrderKind;
}

/**
 * Orders tab (OPD-04, docs/11 §2.4): the sheet's quick-tick list in the same order and names,
 * search for anything else, and admission advice. An order already on a bill cannot be unticked
 * here (billing removes it first).
 */
export function OrdersTab({
  quick,
  orders,
  locked,
  known,
  onOrders,
  onKnown,
  admission,
  onAdmission,
  today,
}: {
  quick: { label: string; services: ServiceInfo[] }[];
  orders: string[];
  /** Services whose order is on a bill. */
  locked: ReadonlySet<string>;
  known: ReadonlyMap<string, ServiceInfo>;
  onOrders: (ids: string[]) => void;
  onKnown: (s: ServiceInfo) => void;
  admission: RxState['admission'];
  onAdmission: (a: RxState['admission']) => void;
  today: string;
}) {
  const t = useTranslations('rx');
  const trpc = useTRPC();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 200);
  const found = useQuery(
    trpc.rx.searchOrders.queryOptions(debounced.length >= 2 ? { q: debounced } : skipToken, {
      placeholderData: keepPreviousData,
    }),
  );
  const selected = new Set(orders);
  const toggleLabel = (ids: string[]) => {
    const all = ids.every((id) => selected.has(id));
    if (all) onOrders(orders.filter((o) => !ids.includes(o) || locked.has(o)));
    else onOrders([...orders, ...ids.filter((id) => !selected.has(id))]);
  };
  const quickIds = new Set(quick.flatMap((x) => x.services.map((s) => s.id)));
  const others = orders.filter((o) => !quickIds.has(o));

  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="text-lg font-semibold">{t('orders.quick')}</legend>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="rx-quick-orders">
          {quick.map((x) => {
            const ids = x.services.map((s) => s.id);
            const on = ids.length > 0 && ids.every((id) => selected.has(id));
            const lockedAll = on && ids.every((id) => locked.has(id));
            return (
              <label
                key={x.label}
                className={cn(
                  'flex min-h-12 cursor-pointer items-center gap-3 rounded-md border-2 px-3 text-lg',
                  on ? 'border-primary bg-primary/5' : 'border-input',
                  ids.length === 0 && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  className="size-6 accent-primary"
                  checked={on}
                  disabled={ids.length === 0 || lockedAll}
                  onChange={() => toggleLabel(ids)}
                />
                <span className="flex-1">{x.label}</span>
                {ids.length === 0 && <span className="text-sm">{t('orders.notSetUp')}</span>}
                {lockedAll && <span className="text-sm font-medium">{t('orders.onBill')}</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <label htmlFor="rx-order-search" className="text-lg font-semibold">
          {t('orders.search')}
        </label>
        <Input
          id="rx-order-search"
          type="search"
          autoComplete="off"
          value={q}
          placeholder={t('orders.searchPlaceholder')}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xl"
        />
        {debounced.length >= 2 && found.data && (
          <ul
            className="max-w-xl divide-y rounded-lg border bg-card"
            aria-label={t('orders.results')}
          >
            {found.data.length === 0 && (
              <li className="p-3 text-muted-foreground">{t('orders.none')}</li>
            )}
            {found.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 p-2">
                <span>
                  {s.name}{' '}
                  <span className="text-sm text-muted-foreground">· {t(`kinds.${s.kind}`)}</span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={selected.has(s.id)}
                  onClick={() => {
                    onKnown({ id: s.id, name: s.name, kind: s.kind });
                    onOrders([...orders, s.id]);
                    setQ('');
                  }}
                >
                  <Plus aria-hidden />
                  {selected.has(s.id) ? t('orders.added') : t('orders.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label={t('orders.other')}>
            {others.map((id) => (
              <li
                key={id}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border-2 border-primary px-3"
              >
                {known.get(id)?.name ?? id}
                {!locked.has(id) && (
                  <button
                    type="button"
                    className="rounded-full p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60"
                    aria-label={t('orders.removeOne', { name: known.get(id)?.name ?? '' })}
                    onClick={() => onOrders(orders.filter((o) => o !== id))}
                  >
                    <X aria-hidden className="size-5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <fieldset className="space-y-3 rounded-lg border-2 p-4">
        <legend className="px-1 text-lg font-semibold">{t('orders.admission')}</legend>
        <div className="flex flex-wrap gap-2">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={admission.advised === v}
              className={chipClass(admission.advised === v)}
              onClick={() => onAdmission({ ...admission, advised: v })}
            >
              {v ? t('orders.admissionYes') : t('orders.admissionNo')}
            </button>
          ))}
        </div>
        {admission.advised && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="rx-adm-date" className="font-medium">
                {t('orders.expectedDate')}
              </label>
              <Input
                id="rx-adm-date"
                type="date"
                min={today}
                value={admission.expectedDate ?? ''}
                onChange={(e) =>
                  onAdmission({ ...admission, expectedDate: e.target.value || null })
                }
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="rx-adm-note" className="font-medium">
                {t('orders.admissionNote')}
              </label>
              <Input
                id="rx-adm-note"
                value={admission.note ?? ''}
                placeholder={t('orders.admissionNoteHint')}
                onChange={(e) => onAdmission({ ...admission, note: e.target.value || null })}
              />
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}

/** Notes & diagnosis (docs/11 §2.5): optional by default, chips first, free text after. */
export function NotesTab({
  note,
  chips,
  onNote,
  required,
}: {
  note: RxState['note'];
  chips: { complaints: string[]; advice: string[] };
  onNote: (n: RxState['note']) => void;
  required: boolean;
}) {
  const t = useTranslations('rx');
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        {required ? t('notes.required') : t('notes.optional')}
      </p>
      <fieldset className="space-y-2">
        <legend className="text-lg font-semibold">{t('notes.complaints')}</legend>
        <div className="flex flex-wrap gap-2">
          {chips.complaints.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={note.complaints.includes(c)}
              className={chipClass(note.complaints.includes(c))}
              onClick={() => onNote({ ...note, complaints: toggle(note.complaints, c) })}
            >
              {c}
            </button>
          ))}
        </div>
        <label htmlFor="rx-complaints" className="sr-only">
          {t('notes.complaintsText')}
        </label>
        <textarea
          id="rx-complaints"
          className={textAreaClass}
          placeholder={t('notes.complaintsText')}
          value={note.complaintsText ?? ''}
          onChange={(e) => onNote({ ...note, complaintsText: e.target.value || null })}
        />
      </fieldset>
      <div className="space-y-1">
        <label htmlFor="rx-diagnosis" className="text-lg font-semibold">
          {t('notes.diagnosis')}
        </label>
        <Input
          id="rx-diagnosis"
          value={note.diagnosis ?? ''}
          onChange={(e) => onNote({ ...note, diagnosis: e.target.value || null })}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-lg font-semibold">{t('notes.advice')}</legend>
        <div className="flex flex-wrap gap-2">
          {chips.advice.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={note.advice.includes(c)}
              className={chipClass(note.advice.includes(c))}
              onClick={() => onNote({ ...note, advice: toggle(note.advice, c) })}
            >
              {c}
            </button>
          ))}
        </div>
        <label htmlFor="rx-advice" className="sr-only">
          {t('notes.adviceText')}
        </label>
        <textarea
          id="rx-advice"
          className={textAreaClass}
          placeholder={t('notes.adviceText')}
          value={note.adviceText ?? ''}
          onChange={(e) => onNote({ ...note, adviceText: e.target.value || null })}
        />
      </fieldset>
    </div>
  );
}

/**
 * Follow-up (docs/11 §2.6): "after N days" buttons or a date; past dates cannot be picked
 * (docs/05 §1.10). The reminder message goes out with the WhatsApp module (MSG-01).
 */
export function FollowUpTab({
  date,
  onDate,
  now,
}: {
  date: string | null;
  onDate: (d: string | null) => void;
  now: Date;
}) {
  const t = useTranslations('rx');
  const min = followUpDateAfter(now, 1);
  const max = followUpDateAfter(now, FOLLOW_UP_MAX_DAYS);
  const valid = !date || isValidFollowUpDate(date, now);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {FOLLOW_UP_QUICK_DAYS.map((n) => {
          const d = followUpDateAfter(now, n);
          return (
            <button
              key={n}
              type="button"
              aria-pressed={date === d}
              className={chipClass(date === d)}
              onClick={() => onDate(d)}
            >
              {t('followUp.after', { n })}
            </button>
          );
        })}
      </div>
      <div className="max-w-xs space-y-1">
        <label htmlFor="rx-follow-up" className="text-lg font-semibold">
          {t('followUp.date')}
        </label>
        <Input
          id="rx-follow-up"
          type="date"
          min={min}
          max={max}
          value={date ?? ''}
          aria-invalid={!valid || undefined}
          onChange={(e) => onDate(e.target.value || null)}
        />
      </div>
      {date && valid && (
        <p className="text-xl font-semibold" data-testid="rx-follow-up-shown">
          {t('followUp.on', { date: formatDate(date) })}
        </p>
      )}
      {!valid && (
        <p role="alert" className="font-medium text-destructive">
          {t('followUp.invalid')}
        </p>
      )}
      {date && (
        <Button type="button" variant="outline" onClick={() => onDate(null)}>
          {t('followUp.clear')}
        </Button>
      )}
      <p className="text-muted-foreground">{t('followUp.reminder')}</p>
    </div>
  );
}
