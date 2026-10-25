'use client';

import { Input } from '@hmis/ui/components/input';
import { FieldMessage, Label } from '@hmis/ui/components/label';
import { useId, type ComponentProps } from 'react';
import { useFieldError } from '@/lib/use-error-text';

type TextFieldProps = ComponentProps<typeof Input> & {
  label: string;
  /** Validation message key (translated here). */
  error?: string;
  help?: string;
};

/** Label + input + inline error/hint, wired for screen readers. */
export function TextField({ label, error, help, id, ...props }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const fieldError = useFieldError();
  const message = fieldError(error);
  const describedBy = [message && `${inputId}-error`, help && `${inputId}-help`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        aria-invalid={!!message || undefined}
        aria-describedby={describedBy || undefined}
        {...props}
      />
      {help && (
        <p id={`${inputId}-help`} className="text-sm text-muted-foreground">
          {help}
        </p>
      )}
      {message && <FieldMessage id={`${inputId}-error`}>{message}</FieldMessage>}
    </div>
  );
}

/** Error/success line for a whole form (announced to screen readers). */
export function FormStatus({ error, success }: { error?: string | null; success?: string | null }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {error && <FieldMessage role="alert">{error}</FieldMessage>}
      {!error && success && <p className="text-sm font-medium text-money">{success}</p>}
    </div>
  );
}
