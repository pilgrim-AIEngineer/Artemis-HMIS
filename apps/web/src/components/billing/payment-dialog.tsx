'use client';

import {
  amountInWords,
  cashChange,
  formatINR,
  maskRef,
  parseRupeeText,
  paiseToRupeeText,
  sumPaise,
  upiRefNeeded,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { ConfirmMoneyDialog } from '@hmis/ui/components/confirm-money-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { MoneyInput } from '@hmis/ui/components/money-input';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

const MODES = ['cash', 'upi', 'card', 'split'] as const;
type Mode = (typeof MODES)[number];
type Part = 'cash' | 'upi' | 'card';

/** One mode of the payment as sent to `billing.collect` (paise as a string, rule 1). */
interface UiTender {
  mode: Part;
  amountPaise: string;
  upiRef?: string;
  upiPayerName?: string;
  cardLast4?: string;
}

export interface PaidResult {
  collectionId: string;
  receiptNumber: string;
  billNumber: string | null;
  billStatus: string;
  balancePaise: string;
  totalPaise: string;
  tokenNo: number | null;
  printSheet: boolean;
}

/**
 * Collect a payment on a bill (BIL-02, docs/12 §3): amount due in large text and words, mode
 * Cash (default, with "cash received" and the change to return), UPI (static QR; UTR optional or
 * required per setting), Card (last 4 digits) or Split across them. Keyboard: arrow keys pick the
 * mode, Tab moves through the fields, Enter goes to the confirmation, Enter again confirms.
 *
 * One `idempotencyKey` per opening of the dialog: a double press, or a retry after a timeout,
 * returns the first result instead of making a second receipt (AGENTS.md rule 9).
 */
export function PaymentDialog({
  billId,
  balancePaise,
  open,
  onOpenChange,
  onPaid,
}: {
  billId: string;
  balancePaise: bigint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid: (r: PaidResult) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <PaymentForm
          billId={billId}
          balancePaise={balancePaise}
          onDone={(r) => {
            onOpenChange(false);
            onPaid(r);
          }}
        />
      )}
    </Dialog>
  );
}

function PaymentForm({
  billId,
  balancePaise,
  onDone,
}: {
  billId: string;
  balancePaise: bigint;
  onDone: (r: PaidResult) => void;
}) {
  const t = useTranslations('billing');
  const tc = useTranslations('common');
  const locale = useLocale() === 'hi' ? 'hi' : 'en';
  const errorText = useErrorText();
  const trpc = useTRPC();
  const settings = useQuery(trpc.billing.paymentSettings.queryOptions());
  const upiRule = settings.data?.upiRef ?? { mode: 'optional' as const, abovePaise: 200_000 };

  const dueText = paiseToRupeeText(balancePaise).replace(/,/g, '');
  const [mode, setMode] = useState<Mode>('cash');
  const [amounts, setAmounts] = useState<Record<Part, string>>({
    cash: dueText,
    upi: dueText,
    card: dueText,
  });
  const [split, setSplit] = useState<Record<Part, string>>({ cash: '', upi: '', card: '' });
  const [tendered, setTendered] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [upiPayerName, setUpiPayerName] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const key = useRef(crypto.randomUUID());

  const collect = useMutation(
    trpc.billing.collect.mutationOptions({ onSuccess: (r) => onDone(r) }),
  );

  const parts: Part[] = mode === 'split' ? ['cash', 'upi', 'card'] : [mode];
  const amountOf = (p: Part) =>
    (mode === 'split' ? parseRupeeText(split[p]) : parseRupeeText(amounts[p])) ?? 0n;
  const tenders: UiTender[] = parts
    .filter((p) => amountOf(p) > 0n)
    .map((p) => {
      const amountPaise = amountOf(p).toString();
      if (p === 'upi') {
        return {
          mode: 'upi',
          amountPaise,
          upiRef: upiRef || undefined,
          upiPayerName: upiPayerName || undefined,
        };
      }
      if (p === 'card') return { mode: 'card', amountPaise, cardLast4: cardLast4 || undefined };
      return { mode: 'cash', amountPaise };
    });
  const total = sumPaise(parts.map(amountOf));
  const remaining = balancePaise - total;
  const cashPart = parts.includes('cash') ? amountOf('cash') : 0n;
  const tenderedPaise = parseRupeeText(tendered);
  const change = tenderedPaise === null ? null : cashChange(tenderedPaise, cashPart);
  const upiPart = parts.includes('upi') ? amountOf('upi') : 0n;
  const showUpi = upiPart > 0n && upiRule.mode !== 'off';
  const showCard = parts.includes('card') && amountOf('card') > 0n;

  const check = (): string | null => {
    if (total <= 0n) return t('pay.enterAmount');
    if (total > balancePaise) return t('pay.moreThanDue', { due: formatINR(balancePaise) });
    if (upiPart > 0n && upiRefNeeded(upiRule, upiPart) && !upiRef) return t('pay.utrRequired');
    if (upiRef && !/^\d{4,12}$/.test(upiRef)) return t('pay.utrInvalid');
    if (cardLast4 && !/^\d{4}$/.test(cardLast4)) return t('pay.cardInvalid');
    return null;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = check();
    setProblem(p);
    if (!p) {
      collect.reset();
      setConfirming(true);
    }
  };

  const words = (p: bigint) => (p > 0n ? amountInWords(p, locale) : null);

  return (
    <DialogContent
      closeLabel={tc('close')}
      className="max-w-2xl"
      data-testid="payment-dialog"
      // Start in the amount field (pre-filled with the amount due), not on the first mode button.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const el = document.getElementById('pay-amount');
        if (el instanceof HTMLInputElement) el.select();
      }}
    >
      <DialogTitle>{t('pay.title')}</DialogTitle>
      <DialogDescription asChild>
        <div className="space-y-1 rounded-lg border-2 border-money/50 bg-money/5 p-4 text-foreground">
          <p className="text-muted-foreground">{t('pay.due')}</p>
          <p className="text-5xl font-bold tabular-nums" data-testid="amount-due">
            {formatINR(balancePaise)}
          </p>
          <p className="text-lg">{amountInWords(balancePaise, locale)}</p>
        </div>
      </DialogDescription>

      <form className="space-y-4" onSubmit={submit} noValidate>
        <fieldset>
          <legend className="mb-2 text-lg font-semibold">{t('pay.mode')}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {MODES.map((m) => (
              <label
                key={m}
                className={cn(
                  'flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 px-3 text-lg font-semibold focus-within:ring-[3px] focus-within:ring-ring/60',
                  mode === m ? 'border-money bg-money/10' : 'border-input bg-card hover:bg-accent',
                )}
              >
                <input
                  type="radio"
                  name="pay-mode"
                  value={m}
                  className="sr-only"
                  checked={mode === m}
                  onChange={() => {
                    setMode(m);
                    setProblem(null);
                  }}
                />
                {t(`modes.${m}`)}
              </label>
            ))}
          </div>
        </fieldset>

        {mode === 'split' ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {(['cash', 'upi', 'card'] as const).map((p) => (
              <div key={p} className="space-y-1">
                <Label htmlFor={`split-${p}`}>
                  {t('pay.splitAmount', { mode: t(`modes.${p}`) })}
                </Label>
                <MoneyInput
                  id={`split-${p}`}
                  value={split[p]}
                  onChange={(v) => setSplit((s) => ({ ...s, [p]: v }))}
                />
              </div>
            ))}
            <p
              className={cn(
                'text-lg font-medium sm:col-span-3',
                remaining < 0n ? 'text-destructive' : remaining > 0n ? '' : 'text-money',
              )}
              aria-live="polite"
              data-testid="split-remaining"
            >
              {remaining < 0n
                ? t('pay.over', { amount: formatINR(-remaining) })
                : t('pay.remaining', { amount: formatINR(remaining) })}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="pay-amount">{t('pay.amount')}</Label>
            <MoneyInput
              id="pay-amount"
              size="lg"
              value={amounts[mode]}
              onChange={(v) => setAmounts((a) => ({ ...a, [mode]: v }))}
              words={words(amountOf(mode))}
            />
            {total > 0n && total < balancePaise && (
              <p className="font-medium">
                {t('pay.partial', { amount: formatINR(balancePaise - total) })}
              </p>
            )}
          </div>
        )}

        {cashPart > 0n && (
          <div className="grid items-end gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pay-tendered">{t('pay.tendered')}</Label>
              <MoneyInput id="pay-tendered" value={tendered} onChange={setTendered} />
            </div>
            <p className="text-xl font-semibold" aria-live="polite" data-testid="cash-change">
              {tenderedPaise === null
                ? ''
                : change === null
                  ? t('pay.short', { amount: formatINR(cashPart - tenderedPaise) })
                  : t('pay.change', { amount: formatINR(change) })}
            </p>
          </div>
        )}

        {showUpi && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pay-utr">
                {upiRefNeeded(upiRule, upiPart) ? t('pay.utrNeeded') : t('pay.utr')}
              </Label>
              <Input
                id="pay-utr"
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                value={upiRef}
                onChange={(e) => setUpiRef(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pay-upi-name">{t('pay.upiPayerName')}</Label>
              <Input
                id="pay-upi-name"
                autoComplete="off"
                maxLength={80}
                value={upiPayerName}
                onChange={(e) => setUpiPayerName(e.target.value)}
              />
            </div>
          </div>
        )}

        {showCard && (
          <div className="max-w-xs space-y-1">
            <Label htmlFor="pay-card">{t('pay.cardLast4')}</Label>
            <Input
              id="pay-card"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={cardLast4}
              onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        )}

        {problem && (
          <p role="alert" className="font-medium text-destructive">
            {problem}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" variant="money" size="lg" data-testid="pay-submit">
            {t('pay.collect', { amount: formatINR(total > 0n ? total : 0n) })}
          </Button>
        </div>
      </form>

      <ConfirmMoneyDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('pay.confirmTitle')}
        amountText={formatINR(total)}
        words={amountInWords(total, locale)}
        confirmLabel={t('pay.confirm')}
        cancelLabel={t('pay.back')}
        closeLabel={tc('close')}
        pending={collect.isPending}
        error={collect.error ? errorText(collect.error) : null}
        onConfirm={() => collect.mutate({ billId, tenders, idempotencyKey: key.current })}
      >
        <ul className="space-y-1 text-lg">
          {tenders.map((tn) => (
            <li key={tn.mode} className="flex justify-between gap-4 tabular-nums">
              <span>
                {t(`modes.${tn.mode}`)}
                {tn.mode === 'upi' && tn.upiRef && ` · UTR ${maskRef(tn.upiRef)}`}
                {tn.mode === 'card' && tn.cardLast4 && ` · …${tn.cardLast4}`}
              </span>
              <span>{formatINR(BigInt(tn.amountPaise))}</span>
            </li>
          ))}
          {change !== null && change > 0n && (
            <li className="font-semibold">{t('pay.change', { amount: formatINR(change) })}</li>
          )}
        </ul>
      </ConfirmMoneyDialog>
    </DialogContent>
  );
}
