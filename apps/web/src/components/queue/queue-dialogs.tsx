'use client';

import { QUEUE_PRIORITIES, type QueuePriority } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { FieldMessage, Label } from '@hmis/ui/components/label';
import { Select } from '@hmis/ui/components/select';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';

export interface DialogBase {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Token number shown in the title so the right patient is acted on. */
  tokenNo: number;
  pending: boolean;
}

function Frame({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  confirm,
  pending,
  disabled,
  children,
}: DialogBase & {
  title: string;
  description?: string;
  onSubmit: () => void;
  confirm: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations('queue');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!disabled && !pending) onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')} className="max-w-lg">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        <form onSubmit={submit} className="space-y-4">
          {children}
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={disabled || pending}>
              {confirm}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** No-show needs a short reason (docs/10 §5). */
export function NoShowDialog({
  onConfirm,
  ...base
}: DialogBase & { onConfirm: (reason: string) => void }) {
  const t = useTranslations('queue');
  const id = useId();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Frame
      {...base}
      title={t('noShowTitle', { no: base.tokenNo })}
      onSubmit={() => onConfirm(trimmed)}
      confirm={t('noShow')}
      disabled={trimmed.length < 3}
    >
      <div className="space-y-2">
        <Label htmlFor={id}>{t('reasonLabel')}</Label>
        <Input
          id={id}
          autoFocus
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('reasonPlaceholder')}
        />
        {trimmed.length > 0 && trimmed.length < 3 && (
          <FieldMessage>{t('reasonShort')}</FieldMessage>
        )}
      </div>
    </Frame>
  );
}

export function TransferDialog({
  doctors,
  currentDoctorId,
  onConfirm,
  ...base
}: DialogBase & {
  doctors: { id: string; name: string }[];
  currentDoctorId: string;
  onConfirm: (doctorId: string) => void;
}) {
  const t = useTranslations('queue');
  const id = useId();
  const options = doctors.filter((d) => d.id !== currentDoctorId);
  const [doctorId, setDoctorId] = useState('');
  return (
    <Frame
      {...base}
      title={t('transferTitle', { no: base.tokenNo })}
      description={t('transferHint')}
      onSubmit={() => onConfirm(doctorId)}
      confirm={t('transfer')}
      disabled={!doctorId}
    >
      <div className="space-y-2">
        <Label htmlFor={id}>{t('transferTo')}</Label>
        <Select id={id} autoFocus value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          <option value="">{t('chooseDoctor')}</option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </div>
    </Frame>
  );
}

export function PriorityDialog({
  current,
  onConfirm,
  ...base
}: DialogBase & { current: QueuePriority; onConfirm: (p: QueuePriority) => void }) {
  const t = useTranslations('queue');
  const id = useId();
  const [priority, setPriority] = useState<QueuePriority>(current);
  return (
    <Frame
      {...base}
      title={t('priorityTitle', { no: base.tokenNo })}
      onSubmit={() => onConfirm(priority)}
      confirm={t('priority')}
      disabled={priority === current}
    >
      <div className="space-y-2">
        <Label htmlFor={id}>{t('priorityLabel')}</Label>
        <Select
          id={id}
          autoFocus
          value={priority}
          onChange={(e) => setPriority(e.target.value as QueuePriority)}
        >
          {QUEUE_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`priorities.${p}`)}
            </option>
          ))}
        </Select>
      </div>
    </Frame>
  );
}
