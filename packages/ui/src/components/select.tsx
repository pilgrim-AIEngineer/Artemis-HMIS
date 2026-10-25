import type * as React from 'react';
import { cn } from '../lib/utils';

/** Native select, styled like `Input` (≥ 44 px, 16 px text): works with touch and keyboard. */
export function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'flex min-h-11 w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/** Checkbox with a large hit area; wrap in a `<label>` with the text. */
export function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'size-6 shrink-0 cursor-pointer rounded accent-primary outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
