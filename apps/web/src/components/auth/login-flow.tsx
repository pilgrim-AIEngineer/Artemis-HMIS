'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginPasswordSchema, passwordSchema, totpCodeSchema, usernameSchema } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormStatus, TextField } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

export type LoginStep = 'credentials' | 'totp' | 'password';

const credentialsSchema = z.object({ username: usernameSchema, password: loginPasswordSchema });
const totpSchema = z.object({ code: totpCodeSchema });
const changeSchema = z
  .object({
    currentPassword: loginPasswordSchema,
    newPassword: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'auth.changePassword.mismatch',
  });

/**
 * Sign-in as a short stepper (docs/05 §1.2): username + password → (remote owner/admin) the
 * 6-digit phone code → (after an admin reset) a new password → home.
 */
export function LoginFlow({
  initialStep,
  notice,
}: {
  initialStep: LoginStep;
  notice: 'pinLockedOut' | 'signedOut' | null;
}) {
  const [step, setStep] = useState<LoginStep>(initialStep);
  const router = useRouter();
  const queryClient = useQueryClient();
  const goHome = () => {
    queryClient.clear();
    router.replace('/');
    router.refresh();
  };
  const next = (n: 'totp' | 'change_password' | 'home') =>
    n === 'totp' ? setStep('totp') : n === 'change_password' ? setStep('password') : goHome();

  return (
    <section className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      {step === 'credentials' && <CredentialsStep notice={notice} onNext={next} />}
      {step === 'totp' && <TotpStep onNext={next} onCancel={() => setStep('credentials')} />}
      {step === 'password' && (
        <ChangePasswordStep onDone={goHome} onCancel={() => setStep('credentials')} />
      )}
    </section>
  );
}

type Next = (n: 'totp' | 'change_password' | 'home') => void;

function CredentialsStep({
  notice,
  onNext,
}: {
  notice: 'pinLockedOut' | 'signedOut' | null;
  onNext: Next;
}) {
  const t = useTranslations('auth');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [show, setShow] = useState(false);
  const form = useForm({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { username: '', password: '' },
  });
  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: (r) => onNext(r.next),
      onError: () => form.setValue('password', ''),
    }),
  );
  const { errors } = form.formState;
  return (
    <form
      noValidate
      onSubmit={(e) => void form.handleSubmit((v) => login.mutate(v))(e)}
      className="space-y-5"
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('login.title')}</h1>
        <p className="text-muted-foreground">{t('login.subtitle')}</p>
      </div>
      {notice && (
        <p className="rounded-md border-2 border-primary/40 p-3">{t(`notice.${notice}`)}</p>
      )}
      <TextField
        label={t('login.username')}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus
        error={errors.username?.message}
        {...form.register('username')}
      />
      <div className="space-y-2">
        <TextField
          label={t('login.password')}
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0"
          onClick={() => setShow((s) => !s)}
        >
          {show ? t('login.hidePassword') : t('login.showPassword')}
        </Button>
      </div>
      <FormStatus error={login.error ? errorText(login.error) : null} />
      <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
        {t('login.submit')}
      </Button>
    </form>
  );
}

function TotpStep({ onNext, onCancel }: { onNext: Next; onCancel: () => void }) {
  const t = useTranslations('auth.totp');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const form = useForm({ resolver: zodResolver(totpSchema), defaultValues: { code: '' } });
  const verify = useMutation(
    trpc.auth.verifyTotp.mutationOptions({
      onSuccess: (r) => onNext(r.next),
      onError: (err) => {
        form.setValue('code', '');
        // Lockout ends the pending session: back to the first step.
        if (err.message === 'errors.auth.lockedOut') onCancel();
      },
    }),
  );
  const logout = useMutation(trpc.auth.logout.mutationOptions({ onSettled: onCancel }));
  return (
    <form
      noValidate
      onSubmit={(e) => void form.handleSubmit((v) => verify.mutate(v))(e)}
      className="space-y-5"
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('help')}</p>
      </div>
      <TextField
        label={t('code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        autoFocus
        className="text-center font-mono text-2xl tracking-[0.4em]"
        error={form.formState.errors.code?.message}
        {...form.register('code')}
      />
      <FormStatus error={verify.error ? errorText(verify.error) : null} />
      <div className="flex justify-between gap-3">
        <Button type="button" variant="outline" onClick={() => logout.mutate()}>
          {tc('cancel')}
        </Button>
        <Button type="submit" size="lg" disabled={verify.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

function ChangePasswordStep({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('auth.changePassword');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const form = useForm({
    resolver: zodResolver(changeSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const change = useMutation(trpc.auth.changePassword.mutationOptions({ onSuccess: onDone }));
  const logout = useMutation(trpc.auth.logout.mutationOptions({ onSettled: onCancel }));
  const { errors } = form.formState;
  return (
    <form
      noValidate
      onSubmit={(e) =>
        void form.handleSubmit(({ currentPassword, newPassword }) =>
          change.mutate({ currentPassword, newPassword }),
        )(e)
      }
      className="space-y-5"
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('help')}</p>
      </div>
      <TextField
        label={t('current')}
        type="password"
        autoComplete="current-password"
        autoFocus
        error={errors.currentPassword?.message}
        {...form.register('currentPassword')}
      />
      <TextField
        label={t('new')}
        type="password"
        autoComplete="new-password"
        error={errors.newPassword?.message}
        {...form.register('newPassword')}
      />
      <TextField
        label={t('confirm')}
        type="password"
        autoComplete="new-password"
        error={errors.confirm?.message}
        {...form.register('confirm')}
      />
      <FormStatus error={change.error ? errorText(change.error) : null} />
      <div className="flex justify-between gap-3">
        <Button type="button" variant="outline" onClick={() => logout.mutate()}>
          {tc('cancel')}
        </Button>
        <Button type="submit" size="lg" disabled={change.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}
