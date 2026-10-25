'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { bpToPercent, formatDateTime, istToday, percentToBp, toIsoDate } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { FieldMessage, Label } from '@hmis/ui/components/label';
import { Checkbox, Select } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { useMastersT } from '@/lib/masters-t';
import { useId, useState } from 'react';
import { Controller, useForm, type Control, type FieldValues } from 'react-hook-form';
import { FormStatus } from '@/components/form/text-field';
import { useErrorText, useFieldError } from '@/lib/use-error-text';
import { cellText, useLookup, useMasterMutation, type LookupItem, type Row } from './api';
import { ConsultationRules } from './consultation-rules';
import { ENUMS, rowToForm, type FieldDef, type MasterDef } from './definitions';

interface Props {
  def: MasterDef;
  /** Existing record, or null to create. */
  row: Row | null;
  onSaved: () => void;
  /** After a cancel: the caller shows the Undo toast. */
  onCancelled: (row: Row) => void;
  onClose: () => void;
}

export function MasterForm({ def, row, onSaved, onCancelled, onClose }: Props) {
  const t = useMastersT();
  const errorText = useErrorText();
  const fieldError = useFieldError();
  const editing = row !== null;
  const cancelled = row?.status === 'cancelled';
  const [serverError, setServerError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');

  const create = useMasterMutation(def.kind, 'create');
  const update = useMasterMutation(def.kind, 'update');
  const cancel = useMasterMutation(def.kind, 'cancel');
  const restore = useMasterMutation(def.kind, 'restore');

  const defaults = row
    ? rowToForm(def, row)
    : {
        ...def.defaults,
        ...(def.kind === 'tariffs' ? { effectiveFrom: toIsoDate(istToday()) } : {}),
      };
  const form = useForm<FieldValues>({
    resolver: zodResolver(def.schema as never),
    defaultValues: defaults,
  });
  const title = row ? cellText(row[def.titleKey]) : t(`kinds.${def.kind}.new`);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (row) await update.mutateAsync({ ...values, id: row.id });
      else await create.mutateAsync(values);
      onSaved();
    } catch (e) {
      setServerError(errorText(e));
    }
  });

  const doCancel = async () => {
    if (!row) return;
    setServerError(null);
    if (reason.trim().length < 3) {
      setServerError(fieldError('validation.reason') ?? null);
      return;
    }
    try {
      await cancel.mutateAsync({ id: row.id, reason });
      onCancelled(row);
    } catch (e) {
      setServerError(errorText(e));
    }
  };

  const doRestore = async () => {
    if (!row) return;
    setServerError(null);
    try {
      await restore.mutateAsync({ id: row.id });
      onSaved();
    } catch (e) {
      setServerError(errorText(e));
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {editing ? t('editHelp') : t(`kinds.${def.kind}.help`)}
        </DialogDescription>
      </div>

      {cancelled && row && (
        <div role="status" className="rounded-md border-2 border-destructive p-4">
          <p className="font-semibold text-destructive">{t('status.cancelled')}</p>
          <p>
            {t('cancelledOn', {
              at:
                typeof row.cancelledAt === 'object' && row.cancelledAt
                  ? formatDateTime(row.cancelledAt as Date)
                  : '—',
            })}
            {': '}
            {cellText(row.cancelReason)}
          </p>
        </div>
      )}

      <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-5">
        <fieldset disabled={cancelled} className="grid gap-4 sm:grid-cols-2">
          {def.fields.map((fld) => (
            <FieldInput
              key={fld.name}
              fld={fld}
              control={form.control}
              editing={editing}
              error={fieldError(form.formState.errors[fld.name]?.message as string | undefined)}
              register={form.register}
            />
          ))}
        </fieldset>

        <FormStatus error={serverError} />

        {removing && !cancelled ? (
          <div className="space-y-3 rounded-md border-2 border-destructive p-4">
            <Label htmlFor="cancel-reason">{t('cancelReasonLabel')}</Label>
            <Input
              id="cancel-reason"
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('cancelReasonPlaceholder')}
            />
            <p className="text-sm text-muted-foreground">{t('cancelHelp')}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRemoving(false)}>
                {t('keep')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() => void doCancel()}
              >
                {t('confirmCancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              {editing && !cancelled && (
                <Button type="button" variant="outline" onClick={() => setRemoving(true)}>
                  {t('cancelRecord')}
                </Button>
              )}
              {cancelled && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={restore.isPending}
                  onClick={() => void doRestore()}
                >
                  {t('restore')}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t('close')}
              </Button>
              {!cancelled && (
                <Button type="submit" disabled={create.isPending || update.isPending}>
                  {t('save')}
                </Button>
              )}
            </div>
          </div>
        )}
      </form>

      {def.kind === 'doctors' && row && !cancelled && <ConsultationRules doctorId={row.id} />}
    </div>
  );
}

interface FieldProps {
  fld: FieldDef;
  control: Control<FieldValues>;
  register: ReturnType<typeof useForm<FieldValues>>['register'];
  editing: boolean;
  error?: string;
}

function useOptions(fld: FieldDef): { items: LookupItem[]; loading: boolean } {
  const t = useMastersT();
  const lookup = useLookup(fld.from, !!fld.from);
  if (fld.from) return { items: lookup.data ?? [], loading: lookup.isPending };
  if (fld.enum) {
    return {
      items: ENUMS[fld.enum].map((v) => ({ value: v, label: t(`enums.${fld.enum}.${v}`) })),
      loading: false,
    };
  }
  return { items: [], loading: false };
}

function FieldInput({ fld, control, register, editing, error }: FieldProps) {
  const t = useMastersT();
  const id = useId();
  const options = useOptions(fld);
  const label = t(`fields.${fld.name}`);
  const help = fld.help ? t(`help.${fld.help}`) : undefined;
  const describedBy = [error && `${id}-error`, help && `${id}-help`].filter(Boolean).join(' ');
  const wrap = cn('space-y-2', fld.wide && 'sm:col-span-2');
  const footer = (
    <>
      {help && (
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {help}
        </p>
      )}
      {error && <FieldMessage id={`${id}-error`}>{error}</FieldMessage>}
    </>
  );

  if (fld.type === 'checkbox') {
    return (
      <div className={cn(wrap, 'sm:self-center')}>
        <Controller
          control={control}
          name={fld.name}
          render={({ field }) => (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base font-medium">
              <Checkbox
                id={id}
                checked={!!field.value}
                onChange={(e) => field.onChange(e.target.checked)}
                aria-describedby={describedBy || undefined}
              />
              {label}
            </label>
          )}
        />
        {footer}
      </div>
    );
  }

  if (fld.type === 'weekdays') {
    return (
      <div className={wrap}>
        <Label id={`${id}-label`}>{label}</Label>
        <Controller
          control={control}
          name={fld.name}
          render={({ field }) => (
            <div role="group" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-2">
              {ENUMS.weekday.map((d) => {
                const on = (field.value as string[]).includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      field.onChange(
                        on
                          ? (field.value as string[]).filter((x) => x !== d)
                          : [...(field.value as string[]), d],
                      )
                    }
                    className={cn(
                      'min-h-11 min-w-14 rounded-md border-2 px-3 text-base font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60',
                      on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-card',
                    )}
                  >
                    {t(`enums.weekday.${d}`)}
                  </button>
                );
              })}
            </div>
          )}
        />
        {footer}
      </div>
    );
  }

  if (fld.type === 'gstPercent') {
    return (
      <div className={wrap}>
        <Label htmlFor={id}>{label}</Label>
        <Controller
          control={control}
          name={fld.name}
          render={({ field }) => (
            <PercentInput
              id={id}
              value={field.value as number}
              onChange={field.onChange}
              invalid={!!error}
              describedBy={describedBy}
            />
          )}
        />
        {footer}
      </div>
    );
  }

  if (fld.type === 'select') {
    const locked = fld.lockedOnEdit && editing;
    return (
      <div className={wrap}>
        <Label htmlFor={id}>{label}</Label>
        <Controller
          control={control}
          name={fld.name}
          render={({ field }) => (
            <Select
              id={id}
              aria-invalid={!!error || undefined}
              aria-describedby={describedBy || undefined}
              disabled={locked}
              value={String(field.value ?? '')}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
            >
              {(fld.optional || !fld.enum) && (
                <option value="">{options.loading ? t('loading') : '—'}</option>
              )}
              {options.items.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        />
        {footer}
      </div>
    );
  }

  const isInt = fld.type === 'integer';
  return (
    <div className={wrap}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={fld.type === 'date' ? 'date' : 'text'}
        inputMode={isInt ? 'numeric' : undefined}
        autoComplete="off"
        className={cn(fld.upper && 'uppercase', isInt && 'tabular-nums')}
        disabled={fld.lockedOnEdit && editing}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy || undefined}
        {...register(fld.name, {
          setValueAs: isInt
            ? (v: unknown) => {
                const s = cellText(v).trim();
                if (s === '') return fld.nullable ? null : Number.NaN;
                return /^\d+$/.test(s) ? Number(s) : Number.NaN;
              }
            : undefined,
        })}
      />
      {footer}
    </div>
  );
}

/** GST % typed as a decimal (`5`, `12.5`), stored as basis points (AGENTS.md rule 1). */
function PercentInput({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: number;
  onChange: (bp: number) => void;
  invalid: boolean;
  describedBy: string;
}) {
  const [text, setText] = useState(
    Number.isSafeInteger(value) && value >= 0 ? bpToPercent(value) : '',
  );
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="pr-10 tabular-nums"
        value={text}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            onChange(next.trim() === '' ? 0 : percentToBp(next));
          } catch {
            onChange(Number.NaN);
          }
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
      >
        %
      </span>
    </div>
  );
}
