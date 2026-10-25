import type * as React from 'react';
import { cn } from '../lib/utils';

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('text-base leading-none font-medium select-none', className)}
      {...props}
    />
  );
}

/** Inline field error / hint under an input (plain language, never codes: docs/05 §1.10). */
export function FieldMessage({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm font-medium text-destructive', className)} {...props} />;
}
