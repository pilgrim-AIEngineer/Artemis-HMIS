'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginPasswordSchema, passwordSchema, pinSchema, totpCodeSchema } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useSession } from '@/components/auth/session-provider';
import { FormStatus, TextField } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-lg border bg-card p-5"
    >
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const passwordForm = z
  .object({
    currentPassword: loginPasswordSchema,
    newPassword: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'auth.changePassword.mismatch',
  });

function ChangePassword() {
  const t = useTranslations('account.password');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const form = useForm({
    resolver: zodResolver(passwordForm),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const m = useMutation(
    trpc.auth.changePassword.mutationOptions({ onSuccess: () => form.reset() }),
  );
  const { errors } = form.formState;
  return (
    <Card id="password" title={t('title')}>
      <form
        noValidate
        className="grid max-w-md gap-4"
        onSubmit={(e) => void form.handleSubmit(({ confirm: _c, ...v }) => m.mutate(v))(e)}
      >
        <TextField
          label={t('current')}
          type="password"
          autoComplete="current-password"
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
        <FormStatus
          error={m.error ? errorText(m.error) : null}
          success={m.isSuccess ? t('done') : null}
        />
        <Button type="submit" className="justify-self-end" disabled={m.isPending}>
          {t('submit')}
        </Button>
      </form>
    </Card>
  );
}

const pinForm = z.object({ pin: pinSchema, currentPassword: loginPasswordSchema });

function SetPin() {
  const t = useTranslations('account.pin');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(pinForm),
    defaultValues: { pin: '', currentPassword: '' },
  });
  const m = useMutation(
    trpc.auth.setPin.mutationOptions({
      onSuccess: () => {
        form.reset();
        router.refresh();
      },
    }),
  );
  const { errors } = form.formState;
  return (
    <Card id="pin" title={t('title')}>
      <p className="text-muted-foreground">{t('help')}</p>
      <form
        noValidate
        className="grid max-w-md gap-4"
        onSubmit={(e) => void form.handleSubmit((v) => m.mutate(v))(e)}
      >
        <TextField
          label={t('pin')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          error={errors.pin?.message}
          {...form.register('pin')}
        />
        <TextField
          label={t('password')}
          type="password"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...form.register('currentPassword')}
        />
        <FormStatus
          error={m.error ? errorText(m.error) : null}
          success={m.isSuccess ? t('done') : null}
        />
        <Button type="submit" className="justify-self-end" disabled={m.isPending}>
          {t('submit')}
        </Button>
      </form>
    </Card>
  );
}

function Totp() {
  const t = useTranslations('account.totp');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const router = useRouter();
  const { me } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const start = useMutation(
    trpc.auth.startTotpEnrolment.mutationOptions({ onSuccess: () => setPassword('') }),
  );
  const confirm = useMutation(
    trpc.auth.confirmTotpEnrolment.mutationOptions({
      onSuccess: () => {
        start.reset();
        setCode('');
        router.refresh();
      },
    }),
  );
  const codeOk = totpCodeSchema.safeParse(code).success;
  return (
    <Card id="totp" title={t('title')}>
      <p className="text-muted-foreground">{t('help')}</p>
      {me.totpRequired && <p className="font-medium">{t('required')}</p>}
      <p className="font-medium">{me.totpEnabled ? t('enabled') : t('disabled')}</p>
      {!start.data ? (
        <form
          className="grid max-w-md gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) start.mutate({ currentPassword: password });
          }}
        >
          <TextField
            label={t('password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FormStatus
            error={start.error ? errorText(start.error) : null}
            success={confirm.isSuccess ? t('done') : null}
          />
          <Button
            type="submit"
            variant="outline"
            className="justify-self-end"
            disabled={start.isPending || !password}
          >
            {me.totpEnabled ? t('restart') : t('start')}
          </Button>
        </form>
      ) : (
        <form
          className="grid max-w-md gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (codeOk) confirm.mutate({ code });
          }}
        >
          <p>{t('scan')}</p>
          {/* SVG generated server-side by `qrcode` from our own otpauth URI (no user input). */}
          <div
            role="img"
            aria-label={t('qr')}
            className="size-56 bg-white p-2"
            dangerouslySetInnerHTML={{ __html: start.data.qrSvg }}
          />
          <p>
            {t('manual')}:{' '}
            <code className="font-mono text-lg break-all select-all">{start.data.secret}</code>
          </p>
          <TextField
            label={t('code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <FormStatus error={confirm.error ? errorText(confirm.error) : null} />
          <Button
            type="submit"
            className="justify-self-end"
            disabled={confirm.isPending || !codeOk}
          >
            {t('confirm')}
          </Button>
        </form>
      )}
    </Card>
  );
}

export function AccountForms() {
  return (
    <>
      <SetPin />
      <ChangePassword />
      <Totp />
    </>
  );
}
