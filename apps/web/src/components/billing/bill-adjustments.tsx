'use client';

import {
  amountInWords,
  formatINR,
  parseRupeeText,
  percentToBp,
  refundDue,
  creditableOf,
  type Paise,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { ConfirmMoneyDialog } from '@hmis/ui/components/confirm-money-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@hmis/ui/components/dialog';
import { Input } from '@hmis/ui/components/input';
import { Label } from '@hmis/ui/components/label';
import { MoneyInput } from '@hmis/ui/components/money-input';
import { Select } from '@hmis/ui/components/select';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

/** The server's answer when an amount is above the requester's limit (BIL-03, BIL-04). */
const needsApprover = (e: unknown) =>
  e instanceof TRPCClientError && e.message === 'errors.billing.approvalRequired';

/** A new idempotency key whenever the request itself (not the approver) changes. */
function useRequestKey() {
  const state = useRef<{ sig: string; key: string } | null>(null);
  return (sig: string) => {
    if (state.current?.sig !== sig) state.current = { sig, key: crypto.randomUUID() };
    return state.current.key;
  };
}

/** Supervisor's username + PIN, typed on the same screen (docs/03 §4). Never stored by the UI. */
function ApproverFields({
  username,
  pin,
  onUsername,
  onPin,
  hint,
}: {
  username: string;
  pin: string;
  onUsername: (v: string) => void;
  onPin: (v: string) => void;
  hint: string;
}) {
  const t = useTranslations('billing.adj');
  return (
    <fieldset
      className="space-y-3 rounded-lg border-2 border-primary/60 bg-primary/5 p-3"
      data-testid="approver-fields"
    >
      <legend className="px-1 text-lg font-semibold">{t('approverTitle')}</legend>
      <p>{hint}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="approver-username">{t('approverUsername')}</Label>
          <Input
            id="approver-username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            value={username}
            onChange={(e) => onUsername(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="approver-pin">{t('approverPin')}</Label>
          <Input
            id="approver-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => onPin(e.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>
    </fieldset>
  );
}

function ReasonFields({
  kind,
  reasonId,
  reasonText,
  onReason,
  onText,
  label,
}: {
  kind: 'discount' | 'cancel';
  reasonId: string;
  reasonText: string;
  onReason: (id: string) => void;
  onText: (v: string) => void;
  label: string;
}) {
  const t = useTranslations('billing.adj');
  const locale = useLocale();
  const trpc = useTRPC();
  const reasons = useQuery(trpc.billing.reasons.queryOptions({ kind }));
  const picked = reasons.data?.find((r) => r.id === reasonId);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`${kind}-reason`}>{label}</Label>
        <Select
          id={`${kind}-reason`}
          value={reasonId}
          onChange={(e) => onReason(e.target.value)}
          data-testid={`${kind}-reason`}
        >
          <option value="">{t('reasonPick')}</option>
          {(reasons.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {locale === 'hi' && r.labelHi ? r.labelHi : r.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${kind}-reason-text`}>
          {picked?.code === 'other' ? t('reasonTextNeeded') : t('reasonText')}
        </Label>
        <Input
          id={`${kind}-reason-text`}
          autoComplete="off"
          maxLength={200}
          value={reasonText}
          onChange={(e) => onText(e.target.value)}
        />
      </div>
    </div>
  );
}

interface BillForAdjust {
  id: string;
  grossPaise: bigint;
  patientSharePaise: bigint;
  creditedPaise: bigint;
  paidPaise: bigint;
  lines: { id: string; description: string; descriptionHi: string | null }[];
}

// ---------------------------------------------------------------- discount (BIL-03)

/**
 * Discount on a draft bill: the whole bill or one item, percent or amount, with a mandatory
 * reason. Inside the user's role limit it applies at once; above it the dialog asks for a
 * supervisor's username and PIN on the same screen (docs/03 §4).
 */
export function DiscountDialog({
  bill,
  lineId,
  open,
  onOpenChange,
  onDone,
}: {
  bill: BillForAdjust;
  lineId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DiscountForm
          bill={bill}
          initialLineId={lineId}
          onDone={() => {
            onOpenChange(false);
            onDone();
          }}
        />
      )}
    </Dialog>
  );
}

function DiscountForm({
  bill,
  initialLineId,
  onDone,
}: {
  bill: BillForAdjust;
  initialLineId?: string;
  onDone: () => void;
}) {
  const t = useTranslations('billing.adj');
  const tc = useTranslations('common');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const limits = useQuery(trpc.billing.adjustmentSettings.queryOptions());
  const reasons = useQuery(trpc.billing.reasons.queryOptions({ kind: 'discount' }));
  const keyFor = useRequestKey();
  const [scope, setScope] = useState(initialLineId ?? '');
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showApprover, setShowApprover] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const apply = useMutation(
    trpc.billing.applyDiscount.mutationOptions({
      onSuccess: onDone,
      onError: (e) => {
        if (needsApprover(e)) setShowApprover(true);
        setProblem(null);
      },
    }),
  );

  const limit = limits.data?.discountLimit;
  const limitText = !limit
    ? ''
    : limit.maxPercentBp === null && limit.maxAmountPaise === null
      ? t('limitFree')
      : limit.maxPercentBp === 0 || limit.maxAmountPaise === 0
        ? t('limitNone')
        : t('limitSome', {
            percent: limit.maxPercentBp === null ? '—' : String(limit.maxPercentBp / 100),
            amount: limit.maxAmountPaise === null ? '—' : formatINR(BigInt(limit.maxAmountPaise)),
          });
  const picked = reasons.data?.find((r) => r.id === reasonId);
  const lineName = (l: BillForAdjust['lines'][number]) =>
    locale === 'hi' && l.descriptionHi ? l.descriptionHi : l.description;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let request: Record<string, unknown>;
    try {
      if (kind === 'percent') {
        const bp = percentToBp(value.trim().replace(/,/g, '.'));
        if (bp <= 0) throw new RangeError('zero');
        request = { mode: 'percent', percentBp: bp };
      } else {
        const paise = parseRupeeText(value);
        if (paise === null || paise <= 0n) throw new RangeError('zero');
        request = { mode: 'amount', amountPaise: paise.toString() };
      }
    } catch {
      setProblem(t('enterValue'));
      return;
    }
    if (!reasonId) return setProblem(t('pickReason'));
    if (picked?.code === 'other' && reasonText.trim().length < 3) {
      return setProblem(t('reasonTextMissing'));
    }
    if (showApprover && (!username.trim() || pin.length < 4))
      return setProblem(t('approverMissing'));
    setProblem(null);
    const body = {
      billId: bill.id,
      lineId: scope || undefined,
      reasonCodeId: reasonId,
      reasonText: reasonText.trim() || undefined,
      ...request,
    };
    apply.mutate({
      ...body,
      idempotencyKey: keyFor(JSON.stringify(body)),
      approver: showApprover ? { username: username.trim(), pin } : undefined,
    } as never);
  };

  return (
    <DialogContent closeLabel={tc('close')} className="max-w-xl" data-testid="discount-dialog">
      <DialogTitle>{t('discountTitle')}</DialogTitle>
      <DialogDescription>{limitText}</DialogDescription>
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="discount-scope">{t('scope')}</Label>
            <Select id="discount-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">{t('scopeBill')}</option>
              {bill.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {lineName(l)}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-base font-medium">{t('kind')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['percent', 'amount'] as const).map((k) => (
                <label
                  key={k}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center justify-center rounded-lg border-2 px-3 font-semibold focus-within:ring-[3px] focus-within:ring-ring/60',
                    kind === k ? 'border-primary bg-primary/10' : 'border-input bg-card',
                  )}
                >
                  <input
                    type="radio"
                    name="discount-kind"
                    className="sr-only"
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      setValue('');
                    }}
                  />
                  {t(k)}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="max-w-xs space-y-1">
          <Label htmlFor="discount-value">
            {kind === 'percent' ? t('percentValue') : t('amountValue')}
          </Label>
          {kind === 'percent' ? (
            <Input
              id="discount-value"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              maxLength={6}
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, ''))}
            />
          ) : (
            <MoneyInput id="discount-value" value={value} onChange={setValue} />
          )}
        </div>
        <ReasonFields
          kind="discount"
          reasonId={reasonId}
          reasonText={reasonText}
          onReason={setReasonId}
          onText={setReasonText}
          label={t('reason')}
        />
        {showApprover && (
          <ApproverFields
            username={username}
            pin={pin}
            onUsername={setUsername}
            onPin={setPin}
            hint={
              apply.error && needsApprover(apply.error) ? errorText(apply.error) : t('approverHint')
            }
          />
        )}
        {(problem || (apply.error && !needsApprover(apply.error))) && (
          <p role="alert" className="font-medium text-destructive">
            {problem ?? errorText(apply.error)}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={apply.isPending} data-testid="discount-submit">
            {t('apply')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------- cancel with credit note (BIL-04)

/**
 * Cancel a final bill with a credit note (the whole bill, or an amount), and give back the money
 * that is no longer owed. The refund is shown in large text and words and confirmed like any
 * money action. Above the cancellation or refund thresholds a supervisor's username and PIN are
 * asked for on this screen (docs/12 §5).
 */
export function CancelBillDialog({
  bill,
  open,
  onOpenChange,
  onDone,
}: {
  bill: BillForAdjust;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (r: {
    creditNoteNumber: string;
    refundPaise: string;
    refundCollectionId: string | null;
  }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <CancelForm
          bill={bill}
          onDone={(r) => {
            onOpenChange(false);
            onDone(r);
          }}
        />
      )}
    </Dialog>
  );
}

function CancelForm({
  bill,
  onDone,
}: {
  bill: BillForAdjust;
  onDone: (r: {
    creditNoteNumber: string;
    refundPaise: string;
    refundCollectionId: string | null;
  }) => void;
}) {
  const t = useTranslations('billing.adj');
  const tb = useTranslations('billing');
  const tc = useTranslations('common');
  const locale = useLocale() === 'hi' ? 'hi' : 'en';
  const errorText = useErrorText();
  const trpc = useTRPC();
  const limits = useQuery(trpc.billing.adjustmentSettings.queryOptions());
  const reasons = useQuery(trpc.billing.reasons.queryOptions({ kind: 'cancel' }));
  const keyFor = useRequestKey();

  const remaining = creditableOf(bill);
  const [partial, setPartial] = useState(false);
  const [partialText, setPartialText] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [mode, setMode] = useState<'cash' | 'upi' | 'card'>('cash');
  const [upiRef, setUpiRef] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showApprover, setShowApprover] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const credit: Paise = partial ? (parseRupeeText(partialText) ?? 0n) : remaining;
  const due = credit > 0n && credit <= remaining ? refundDue(bill, credit) : 0n;
  const picked = reasons.data?.find((r) => r.id === reasonId);
  const { me } = useSession();
  const mayRefund = me.permissions.includes('billing.refund.create');
  const lim = limits.data;
  const needsSupervisor =
    !!lim &&
    !lim.canApprove &&
    (credit > BigInt(lim.cancelApprovalAbovePaise) ||
      (due > 0n && due > BigInt(lim.refundApprovalAbovePaise)));
  const approverShown = showApprover || needsSupervisor;

  const cancel = useMutation(
    trpc.billing.cancelBill.mutationOptions({
      onSuccess: (r) => {
        setConfirming(false);
        onDone(r);
      },
      onError: (e) => {
        if (needsApprover(e)) {
          setShowApprover(true);
          setConfirming(false);
        }
      },
    }),
  );

  const request = () => ({
    billId: bill.id,
    reasonCodeId: reasonId,
    reasonText: reasonText.trim() || undefined,
    amountPaise: partial ? credit.toString() : undefined,
    refund:
      due > 0n
        ? {
            mode,
            amountPaise: due.toString(),
            upiRef: mode === 'upi' && upiRef ? upiRef : undefined,
          }
        : undefined,
  });

  const check = (): string | null => {
    if (!reasonId) return t('pickReason');
    if (picked?.code === 'other' && reasonText.trim().length < 3) return t('reasonTextMissing');
    if (due > 0n && !mayRefund) return t('refundNotAllowed');
    if (partial && credit <= 0n) return t('creditEnter');
    if (credit > remaining) return t('creditTooMuch', { amount: formatINR(remaining) });
    if (upiRef && !/^\d{4,12}$/.test(upiRef)) return t('refundRefInvalid');
    if (approverShown && (!username.trim() || pin.length < 4)) return t('approverMissing');
    return null;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = check();
    setProblem(p);
    if (p) return;
    cancel.reset();
    setConfirming(true);
  };

  const send = () => {
    const body = request();
    cancel.mutate({
      ...body,
      idempotencyKey: keyFor(JSON.stringify(body)),
      approver: approverShown ? { username: username.trim(), pin } : undefined,
    });
  };

  return (
    <DialogContent closeLabel={tc('close')} className="max-w-2xl" data-testid="cancel-dialog">
      <DialogTitle>{t('cancelTitle')}</DialogTitle>
      <DialogDescription asChild>
        <div className="space-y-1 rounded-lg border-2 border-destructive/40 bg-destructive/5 p-4 text-foreground">
          <p className="text-muted-foreground">{t('creditAmount')}</p>
          <p className="text-4xl font-bold tabular-nums" data-testid="credit-amount">
            {formatINR(credit > 0n && credit <= remaining ? credit : remaining)}
          </p>
        </div>
      </DialogDescription>
      <form className="space-y-4" onSubmit={submit} noValidate>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">{t('creditAmount')}</legend>
          {[false, true].map((p) => (
            <label
              key={String(p)}
              className={cn(
                'flex min-h-12 cursor-pointer items-center justify-center rounded-lg border-2 px-3 font-semibold focus-within:ring-[3px] focus-within:ring-ring/60',
                partial === p ? 'border-primary bg-primary/10' : 'border-input bg-card',
              )}
            >
              <input
                type="radio"
                name="credit-scope"
                className="sr-only"
                checked={partial === p}
                onChange={() => setPartial(p)}
              />
              {p ? t('creditPartial') : t('creditFull', { amount: formatINR(remaining) })}
            </label>
          ))}
        </fieldset>
        {partial && (
          <div className="max-w-xs space-y-1">
            <Label htmlFor="credit-partial">{t('creditPartialAmount')}</Label>
            <MoneyInput
              id="credit-partial"
              value={partialText}
              onChange={setPartialText}
              words={credit > 0n ? amountInWords(credit, locale) : null}
            />
          </div>
        )}
        <ReasonFields
          kind="cancel"
          reasonId={reasonId}
          reasonText={reasonText}
          onReason={setReasonId}
          onText={setReasonText}
          label={t('cancelReason')}
        />

        {due > 0n ? (
          <section className="space-y-3 rounded-lg border-2 border-money/50 bg-money/5 p-3">
            <p className="text-muted-foreground">{t('refundDue')}</p>
            <p className="text-4xl font-bold text-money tabular-nums" data-testid="refund-amount">
              {formatINR(due)}
            </p>
            <p>{amountInWords(due, locale)}</p>
            <fieldset>
              <legend className="mb-1 font-semibold">{t('refundMode')}</legend>
              <div className="grid grid-cols-3 gap-2">
                {(['cash', 'upi', 'card'] as const).map((m) => (
                  <label
                    key={m}
                    className={cn(
                      'flex min-h-12 cursor-pointer items-center justify-center rounded-lg border-2 px-3 text-lg font-semibold focus-within:ring-[3px] focus-within:ring-ring/60',
                      mode === m ? 'border-money bg-money/10' : 'border-input bg-card',
                    )}
                  >
                    <input
                      type="radio"
                      name="refund-mode"
                      className="sr-only"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    {tb(`modes.${m}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            {mode === 'upi' && (
              <div className="max-w-xs space-y-1">
                <Label htmlFor="refund-ref">{t('refundRef')}</Label>
                <Input
                  id="refund-ref"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={12}
                  value={upiRef}
                  onChange={(e) => setUpiRef(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            )}
          </section>
        ) : (
          <p className="rounded-lg border bg-card p-3">{t('refundNone')}</p>
        )}

        {approverShown && (
          <ApproverFields
            username={username}
            pin={pin}
            onUsername={setUsername}
            onPin={setPin}
            hint={
              cancel.error && needsApprover(cancel.error)
                ? errorText(cancel.error)
                : t('needsApproval') + ' ' + t('approverHint')
            }
          />
        )}
        {problem && (
          <p role="alert" className="font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="lg" variant="destructive" data-testid="cancel-submit">
            {t('continue')}
          </Button>
        </div>
      </form>

      <ConfirmMoneyDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmCancelTitle')}
        amountText={formatINR(due > 0n ? due : credit)}
        words={amountInWords(due > 0n ? due : credit, locale)}
        confirmLabel={due > 0n ? t('confirmCancelOk') : t('confirmCreditOk')}
        cancelLabel={t('back')}
        closeLabel={tc('close')}
        pending={cancel.isPending}
        error={cancel.error && !needsApprover(cancel.error) ? errorText(cancel.error) : null}
        onConfirm={send}
      >
        <ul className="space-y-1 text-lg">
          <li className="flex justify-between gap-4 tabular-nums">
            <span>{t('creditAmount')}</span>
            <span>{formatINR(credit)}</span>
          </li>
          {due > 0n && (
            <li className="flex justify-between gap-4 tabular-nums">
              <span>
                {t('refundDue')} · {tb(`modes.${mode}`)}
              </span>
              <span>{formatINR(due)}</span>
            </li>
          )}
        </ul>
      </ConfirmMoneyDialog>
    </DialogContent>
  );
}

// ---------------------------------------------------------------- void a draft

/** Closes an unpaid draft with a reason (docs/12 §5: the draft never had a number). */
export function VoidDraftDialog({
  billId,
  open,
  onOpenChange,
  onDone,
}: {
  billId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <VoidForm
          billId={billId}
          onDone={() => {
            onOpenChange(false);
            onDone();
          }}
        />
      )}
    </Dialog>
  );
}

function VoidForm({ billId, onDone }: { billId: string; onDone: () => void }) {
  const t = useTranslations('billing.adj');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const reasons = useQuery(trpc.billing.reasons.queryOptions({ kind: 'cancel' }));
  const key = useRef(crypto.randomUUID());
  const [reasonId, setReasonId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const picked = reasons.data?.find((r) => r.id === reasonId);
  const run = useMutation(trpc.billing.voidDraft.mutationOptions({ onSuccess: onDone }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reasonId) return setProblem(t('pickReason'));
    if (picked?.code === 'other' && reasonText.trim().length < 3) {
      return setProblem(t('reasonTextMissing'));
    }
    setProblem(null);
    run.mutate({
      billId,
      reasonCodeId: reasonId,
      reasonText: reasonText.trim() || undefined,
      idempotencyKey: key.current,
    });
  };
  return (
    <DialogContent closeLabel={tc('close')} className="max-w-xl" data-testid="void-dialog">
      <DialogTitle>{t('voidTitle')}</DialogTitle>
      <DialogDescription>{t('voidHint')}</DialogDescription>
      <form className="space-y-4" onSubmit={submit} noValidate>
        <ReasonFields
          kind="cancel"
          reasonId={reasonId}
          reasonText={reasonText}
          onReason={setReasonId}
          onText={setReasonText}
          label={t('cancelReason')}
        />
        {(problem || run.error) && (
          <p role="alert" className="font-medium text-destructive">
            {problem ?? errorText(run.error)}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="lg" variant="destructive" disabled={run.isPending}>
            {t('voidConfirm')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
