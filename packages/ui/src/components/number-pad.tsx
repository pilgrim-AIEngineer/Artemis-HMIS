'use client';

import { Delete } from 'lucide-react';
import type { MouseEvent } from 'react';
import { cn } from '../lib/utils';

export interface NumberPadLabels {
  /** Accessible name of the pad, e.g. "Number pad". */
  pad: string;
  backspace: string;
  decimalPoint: string;
  /** Moves to the next field, e.g. "Next". */
  next: string;
}

export interface NumberPadProps {
  /** Appends a digit or `.` to the field being filled. */
  onKey: (key: string) => void;
  onBackspace: () => void;
  onNext: () => void;
  /** Hides nothing, but disables the point for whole-number fields (pulse, BP …). */
  allowDecimal?: boolean;
  disabled?: boolean;
  labels: NumberPadLabels;
  className?: string;
}

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'] as const;

/**
 * Large decimal keypad for entering readings on a tablet (docs/05 §1.6, docs/11 §1). It does not
 * own the value: it sends keys to whichever field the form says is active. The buttons never take
 * focus, so the field keeps it and a physical keyboard still works beside the pad.
 */
export function NumberPad({
  onKey,
  onBackspace,
  onNext,
  allowDecimal = true,
  disabled = false,
  labels,
  className,
}: NumberPadProps) {
  const keep = (e: MouseEvent) => e.preventDefault();
  const keyClass =
    'flex h-16 items-center justify-center rounded-lg border-2 border-input bg-card text-2xl font-semibold tabular-nums outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/60 active:bg-accent disabled:opacity-50';
  return (
    <div
      role="group"
      aria-label={labels.pad}
      className={cn('grid w-full max-w-xs grid-cols-3 gap-3', className)}
    >
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={keyClass}
          disabled={disabled}
          onMouseDown={keep}
          onClick={() => onKey(k)}
        >
          {k}
        </button>
      ))}
      <button
        type="button"
        className={keyClass}
        disabled={disabled || !allowDecimal}
        aria-label={labels.decimalPoint}
        onMouseDown={keep}
        onClick={() => onKey('.')}
      >
        .
      </button>
      <button
        type="button"
        className={keyClass}
        disabled={disabled}
        onMouseDown={keep}
        onClick={() => onKey('0')}
      >
        0
      </button>
      <button
        type="button"
        className={keyClass}
        disabled={disabled}
        aria-label={labels.backspace}
        onMouseDown={keep}
        onClick={onBackspace}
      >
        <Delete aria-hidden className="size-7" />
      </button>
      <button
        type="button"
        className={cn(
          keyClass,
          'col-span-3 h-14 border-primary bg-primary text-lg text-primary-foreground hover:bg-primary/90',
        )}
        disabled={disabled}
        onMouseDown={keep}
        onClick={onNext}
      >
        {labels.next}
      </button>
    </div>
  );
}
