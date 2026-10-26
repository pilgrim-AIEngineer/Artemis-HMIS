'use client';

import { useId, useState, type KeyboardEvent, type Ref } from 'react';
import { cn } from '../lib/utils';
import { Input } from './input';

export interface DrugPickerOption {
  id: string;
  /** Brand + strength, e.g. `Paracetamol 650 mg`. */
  label: string;
  /** Generic name and form, shown under the label. */
  detail?: string | null;
  /** Short tag such as "Often used" or "Not stocked". */
  badge?: string | null;
}

/**
 * Drug type-ahead (docs/02 §8 `DrugPicker`, docs/11 §2.3): the caller searches and ranks (this
 * doctor's usage, then stocked items); this component shows the options as an ARIA combobox.
 * ↑/↓ move, Enter picks, Esc closes. The last option is always "Add as free text", so an unknown
 * drug never blocks the assistant (it is flagged for the admin to map later). Presentational: the
 * app passes already-translated labels.
 */
export function DrugPicker({
  id,
  value,
  onValueChange,
  options,
  loading = false,
  onPick,
  onFreeText,
  labels,
  inputRef,
  className,
  autoFocus,
}: {
  id?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: readonly DrugPickerOption[];
  loading?: boolean;
  onPick: (o: DrugPickerOption) => void;
  onFreeText: (text: string) => void;
  labels: {
    label: string;
    placeholder?: string;
    list: string;
    loading: string;
    freeText: (text: string) => string;
  };
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  autoFocus?: boolean;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  const listId = `${inputId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const text = value.trim();
  // Options, then "free text" as the last row.
  const rows = text ? [...options, null] : [];
  const shown = open && rows.length > 0;
  // A new option list starts at its first row (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(options);
  if (seen !== options) {
    setSeen(options);
    setActive(0);
  }

  const choose = (i: number) => {
    const o = rows[i];
    setOpen(false);
    if (o) onPick(o);
    else if (text) onFreeText(text);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && shown) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault();
      setOpen(false);
    }
  };
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className={cn('relative', className)}>
      <label htmlFor={inputId} className="sr-only">
        {labels.label}
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        role="combobox"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown ? optionId(active) : undefined}
        placeholder={labels.placeholder}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="min-h-12 text-lg"
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={labels.list}
          aria-busy={loading || undefined}
          className="absolute z-20 mt-1 max-h-80 w-full min-w-72 overflow-auto rounded-lg border-2 bg-card shadow-lg"
        >
          {rows.map((o, i) => (
            <li
              key={o ? o.id : 'free-text'}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: picking must happen before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2',
                i === active && 'bg-accent',
                !o && 'border-t text-muted-foreground',
              )}
            >
              {o ? (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-medium">{o.label}</span>
                    {o.detail && (
                      <span className="block truncate text-sm text-muted-foreground">
                        {o.detail}
                      </span>
                    )}
                  </span>
                  {o.badge && (
                    <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                      {o.badge}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-base">{labels.freeText(text)}</span>
              )}
            </li>
          ))}
          {loading && options.length === 0 && (
            <li role="presentation" className="px-3 py-2 text-muted-foreground">
              {labels.loading}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
