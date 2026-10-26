'use client';

import { cleanRupeeText, groupRupeeText } from '@hmis/shared';
import type * as React from 'react';
import { useId } from 'react';
import { cn } from '../lib/utils';

export interface MoneyInputProps extends Omit<
  React.ComponentProps<'input'>,
  'value' | 'onChange' | 'type' | 'size'
> {
  /** Rupee text as typed, without grouping (`"1250.5"`); parse with `parseRupeeText`. */
  value: string;
  onChange: (value: string) => void;
  /** Amount in words, already translated (docs/05 §2); shown under the field. */
  words?: string | null;
  /** Larger text for the main amount of a dialog. */
  size?: 'default' | 'lg';
}

/**
 * Rupee amount field (docs/02 §8 `MoneyInput`, docs/05 §2): digits and up to two decimals only,
 * Indian grouping while typing (`1,25,000`), `₹` in front, the amount in words underneath, a
 * decimal keypad on tablets. Keys that would make the text invalid are simply not taken, so the
 * value never needs rounding. The app converts to paise at the edge (AGENTS.md rule 1).
 */
export function MoneyInput({
  value,
  onChange,
  words,
  size = 'default',
  className,
  id,
  ...props
}: MoneyInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const wordsId = `${inputId}-words`;
  return (
    <div className="space-y-1">
      <div className="relative">
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-semibold text-muted-foreground',
            size === 'lg' ? 'text-2xl' : 'text-base',
          )}
        >
          ₹
        </span>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          data-slot="money-input"
          aria-describedby={words ? wordsId : undefined}
          value={groupRupeeText(value)}
          onChange={(e) => {
            const clean = cleanRupeeText(e.target.value);
            if (clean !== null) onChange(clean);
          }}
          className={cn(
            'flex w-full rounded-md border-2 border-input bg-card pr-3 text-right font-semibold text-foreground tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive',
            size === 'lg' ? 'min-h-16 pl-10 text-3xl' : 'min-h-11 pl-8 text-lg',
            className,
          )}
          {...props}
        />
      </div>
      {words ? (
        <p id={wordsId} className="text-sm text-muted-foreground" aria-live="polite">
          {words}
        </p>
      ) : null}
    </div>
  );
}
