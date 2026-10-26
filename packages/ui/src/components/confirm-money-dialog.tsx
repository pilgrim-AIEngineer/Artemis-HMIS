'use client';

import type * as React from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

export interface ConfirmMoneyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** `₹1,250.00` */
  amountText: string;
  /** `एक हज़ार दो सौ पचास रुपये` / `One thousand two hundred fifty rupees` */
  words: string;
  /** Extra lines (modes, patient, bill) under the amount. */
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  /** Inline error text from the last attempt. */
  error?: string | null;
}

/**
 * The last step of every money action (docs/02 §8, docs/05 §1.9): repeats the amount in large
 * text and in words, with one green confirm button (focused, so Enter confirms) and a way back
 * (Esc or Cancel). While the request runs the confirm button is disabled, so a second press
 * cannot send it twice; the caller's idempotency key covers retries.
 */
export function ConfirmMoneyDialog({
  open,
  onOpenChange,
  title,
  amountText,
  words,
  children,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onConfirm,
  pending = false,
  error,
}: ConfirmMoneyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent closeLabel={closeLabel} className="max-w-xl" data-testid="confirm-money">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-1 text-foreground">
            <p className="text-5xl font-bold text-money tabular-nums" data-testid="confirm-amount">
              {amountText}
            </p>
            <p className="text-lg">{words}</p>
          </div>
        </DialogDescription>
        {children}
        {error ? (
          <p role="alert" className="font-medium text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="money"
            size="lg"
            autoFocus
            disabled={pending}
            onClick={onConfirm}
            data-testid="confirm-money-ok"
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
