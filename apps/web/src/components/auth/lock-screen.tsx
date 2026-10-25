'use client';

import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { FieldMessage, Label } from '@hmis/ui/components/label';
import { Keypad } from '@hmis/ui/components/keypad';
import { useMutation } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { Lock, UserRoundCog } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import { useErrorText } from '@/lib/use-error-text';
import type { MeView } from '@/server/trpc/routers/auth';
import { useTRPC } from '@/trpc/client';

/** Errors after which this session is gone and a full sign-in is needed. */
const ENDS_SESSION = new Set([
  'errors.auth.pinLockedOut',
  'errors.auth.lockedOut',
  'errors.auth.required',
]);

/**
 * Idle lock screen: the same user unlocks with their PIN (or password when no PIN is set);
 * "Switch user" is always visible and goes to the full login (docs/01 §5, docs/03 §6).
 */
export function LockScreen({
  me,
  onUnlocked,
  onSwitchUser,
}: {
  me: MeView;
  onUnlocked: () => void;
  onSwitchUser: () => void;
}) {
  const t = useTranslations('auth.lock');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const pwId = useId();

  const onError = (err: unknown) => {
    setPin('');
    setPassword('');
    if (err instanceof TRPCClientError && ENDS_SESSION.has(err.message)) {
      router.replace('/login?notice=pinLockedOut');
      return;
    }
    setError(errorText(err));
  };
  const pinUnlock = useMutation(
    trpc.auth.unlockWithPin.mutationOptions({ onSuccess: onUnlocked, onError }),
  );
  const pwUnlock = useMutation(
    trpc.auth.unlockWithPassword.mutationOptions({ onSuccess: onUnlocked, onError }),
  );
  const busy = pinUnlock.isPending || pwUnlock.isPending;

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (password) pwUnlock.mutate({ password });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background p-6"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 py-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-secondary">
            <Lock aria-hidden className="size-7" />
          </span>
          <h1 id={titleId} className="text-2xl font-semibold">
            {t('title')}
          </h1>
          <p className="text-lg">
            {me.hasPin
              ? t('pinPrompt', { name: me.fullName })
              : t('passwordPrompt', { name: me.fullName })}
          </p>
        </div>

        {me.hasPin ? (
          <Keypad
            value={pin}
            onChange={(v) => {
              setError(null);
              setPin(v);
            }}
            onSubmit={(v) => pinUnlock.mutate({ pin: v })}
            disabled={busy}
            labels={{
              keypad: t('keypad'),
              backspace: t('backspace'),
              submit: t('unlock'),
              entered: (count) => t('entered', { count }),
            }}
          />
        ) : (
          <form onSubmit={submitPassword} className="w-full space-y-3">
            <Label htmlFor={pwId}>{t('passwordPrompt', { name: me.fullName })}</Label>
            <Input
              id={pwId}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setError(null);
                setPassword(e.target.value);
              }}
            />
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {t('unlock')}
            </Button>
          </form>
        )}

        <div aria-live="assertive" className="min-h-6 text-center">
          {error && <FieldMessage>{error}</FieldMessage>}
        </div>

        <div className="flex w-full flex-col items-center gap-2 border-t pt-4">
          <p className="text-center text-sm text-muted-foreground">
            {t('notYou', { name: me.fullName })}
          </p>
          <Button variant="outline" size="lg" className="w-full" onClick={onSwitchUser}>
            <UserRoundCog aria-hidden />
            {t('switchUser')}
          </Button>
        </div>
      </div>
    </div>
  );
}
