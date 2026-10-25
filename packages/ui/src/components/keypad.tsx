'use client';

import { Delete } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '../lib/utils';

export interface KeypadLabels {
  /** Accessible name of the whole keypad, e.g. "PIN keypad". */
  keypad: string;
  backspace: string;
  submit: string;
  /** Live region text, e.g. "3 of 6 digits entered". Receives the count. */
  entered: (count: number) => string;
}

export interface KeypadProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  minLength?: number;
  maxLength?: number;
  disabled?: boolean;
  labels: KeypadLabels;
  /** Listen to the physical keyboard (digits, Backspace, Enter) while mounted. */
  captureKeyboard?: boolean;
  className?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * Numeric keypad for PIN entry (docs/02 §8 `Keypad`): large touch targets for tablets, full
 * physical-keyboard support, digits shown only as dots. Labels come from the caller (i18n).
 */
export function Keypad({
  value,
  onChange,
  onSubmit,
  minLength = 4,
  maxLength = 6,
  disabled = false,
  labels,
  captureKeyboard = true,
  className,
}: KeypadProps) {
  const state = useRef({ value, disabled });
  useLayoutEffect(() => {
    state.current = { value, disabled };
  }, [value, disabled]);

  const press = (digit: string) => {
    if (state.current.disabled || state.current.value.length >= maxLength) return;
    onChange(state.current.value + digit);
  };
  const back = () => {
    if (!state.current.disabled) onChange(state.current.value.slice(0, -1));
  };
  const submit = () => {
    if (!state.current.disabled && state.current.value.length >= minLength) {
      onSubmit(state.current.value);
    }
  };
  const handlers = useRef({ press, back, submit });
  useLayoutEffect(() => {
    handlers.current = { press, back, submit };
  });

  useEffect(() => {
    if (!captureKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handlers.current.press(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handlers.current.back();
      } else if (e.key === 'Enter') {
        // Let Enter on a focused button do its own thing.
        if (document.activeElement instanceof HTMLButtonElement) return;
        e.preventDefault();
        handlers.current.submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [captureKeyboard]);

  const keyClass =
    'flex h-16 items-center justify-center rounded-lg border-2 border-input bg-card text-2xl font-semibold outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/60 active:bg-accent disabled:opacity-50';

  return (
    <div
      role="group"
      aria-label={labels.keypad}
      className={cn('w-full max-w-xs space-y-4', className)}
    >
      <div className="flex justify-center gap-3" aria-hidden>
        {Array.from({ length: maxLength }, (_, i) => (
          <span
            key={i}
            data-filled={i < value.length}
            className={cn(
              'size-4 rounded-full border-2 border-foreground/60',
              i < value.length && 'bg-foreground',
              i >= minLength && i >= value.length && 'border-dashed opacity-60',
            )}
          />
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {labels.entered(value.length)}
      </p>
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={keyClass}
            disabled={disabled}
            onClick={() => press(k)}
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          className={keyClass}
          disabled={disabled}
          onClick={back}
          aria-label={labels.backspace}
        >
          <Delete aria-hidden className="size-7" />
        </button>
        <button type="button" className={keyClass} disabled={disabled} onClick={() => press('0')}>
          0
        </button>
        <button
          type="button"
          className={cn(
            keyClass,
            'border-primary bg-primary text-lg text-primary-foreground hover:bg-primary/90',
          )}
          disabled={disabled || value.length < minLength}
          onClick={submit}
        >
          {labels.submit}
        </button>
      </div>
    </div>
  );
}
