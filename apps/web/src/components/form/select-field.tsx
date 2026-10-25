'use client';

import { FieldMessage, Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useId, type ComponentProps } from 'react';
import { useFieldError } from '@/lib/use-error-text';

type SelectFieldProps = ComponentProps<typeof Select> & {
  label: string;
  error?: string;
  /** Text of the empty first option. */
  placeholder: string;
  options: readonly { value: string; label: string }[];
};

/** Label + native select + inline error (touch- and keyboard-friendly). */
export function SelectField({
  label,
  error,
  placeholder,
  options,
  id,
  ...props
}: SelectFieldProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const message = useFieldError()(error);
  return (
    <div className="space-y-2">
      <Label htmlFor={selectId}>{label}</Label>
      <Select
        id={selectId}
        aria-invalid={!!message || undefined}
        aria-describedby={message ? `${selectId}-error` : undefined}
        {...props}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {message && <FieldMessage id={`${selectId}-error`}>{message}</FieldMessage>}
    </div>
  );
}
