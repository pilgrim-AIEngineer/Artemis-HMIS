'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatDateTime,
  fullNameSchema,
  optionalMobileSchema,
  passwordSchema,
  reasonSchema,
  userLocaleSchema,
  usernameSchema,
} from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Label } from '@hmis/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useSession } from '@/components/auth/session-provider';
import { FormStatus, TextField } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import type { AppRouter } from '@/server/trpc/root';
import { useTRPC } from '@/trpc/client';
import { roleName } from './role-name';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-lg border bg-card p-5">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BackLink() {
  const t = useTranslations('admin.users');
  return (
    <Button asChild variant="ghost" className="-ml-3">
      <Link href="/admin/users">
        <ArrowLeft aria-hidden />
        {t('back')}
      </Link>
    </Button>
  );
}

/** Role checkboxes (large touch targets). */
function RolePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const trpc = useTRPC();
  const locale = useLocale();
  const roles = useQuery(trpc.admin.listRoles.queryOptions());
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {(roles.data ?? []).map((r) => (
        <label
          key={r.id}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border-2 px-3 py-2 has-[:checked]:border-primary"
        >
          <input
            type="checkbox"
            className="size-5 accent-[var(--primary)]"
            checked={value.includes(r.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, r.id] : value.filter((v) => v !== r.id))
            }
          />
          <span>{roleName(r, locale)}</span>
        </label>
      ))}
    </div>
  );
}

function LanguageSelect({ id, ...props }: ComponentProps<'select'>) {
  const t = useTranslations('language');
  return (
    <select
      id={id}
      className="min-h-11 w-full rounded-md border-2 border-input bg-card px-3 text-base"
      {...props}
    >
      <option value="hi">{t('hi')}</option>
      <option value="en">{t('en')}</option>
    </select>
  );
}

const createSchema = z.object({
  username: usernameSchema,
  fullName: fullNameSchema,
  mobile: z.string(),
  preferredLocale: userLocaleSchema,
  password: passwordSchema,
});

export function NewUserForm() {
  const t = useTranslations('admin.userForm');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const router = useRouter();
  const langId = useId();
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [mobileError, setMobileError] = useState<string>();
  const form = useForm({
    resolver: zodResolver(createSchema),
    defaultValues: {
      username: '',
      fullName: '',
      mobile: '',
      preferredLocale: 'hi' as const,
      password: '',
    },
  });
  const invalidate = useInvalidateUsers();
  const create = useMutation(
    trpc.admin.createUser.mutationOptions({
      onSuccess: async ({ id }) => {
        await invalidate();
        router.push(`/admin/users/${id}`);
      },
    }),
  );
  const { errors } = form.formState;
  return (
    <div className="max-w-3xl space-y-5">
      <BackLink />
      <h1 className="text-3xl font-semibold">{t('titleNew')}</h1>
      <form
        noValidate
        className="space-y-5"
        onSubmit={(e) =>
          void form.handleSubmit((v) => {
            const mobile = optionalMobileSchema.safeParse(v.mobile);
            if (!mobile.success) return setMobileError(mobile.error.issues[0]?.message);
            setMobileError(undefined);
            create.mutate({ ...v, mobile: mobile.data ?? undefined, roleIds });
          })(e)
        }
      >
        <Section title={t('details')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('fullName')}
              autoFocus
              error={errors.fullName?.message}
              {...form.register('fullName')}
            />
            <TextField
              label={t('username')}
              help={t('usernameHelp')}
              autoCapitalize="none"
              spellCheck={false}
              error={errors.username?.message}
              {...form.register('username')}
            />
            <TextField
              label={t('mobile')}
              inputMode="numeric"
              error={mobileError}
              {...form.register('mobile')}
            />
            <div className="space-y-2">
              <Label htmlFor={langId}>{t('language')}</Label>
              <LanguageSelect id={langId} {...form.register('preferredLocale')} />
            </div>
          </div>
        </Section>
        <Section title={t('roles')}>
          <RolePicker value={roleIds} onChange={setRoleIds} />
        </Section>
        <Section title={t('firstSignIn')}>
          <TextField
            label={t('password')}
            help={t('passwordHelp')}
            type="text"
            autoComplete="off"
            error={errors.password?.message}
            {...form.register('password')}
          />
        </Section>
        <FormStatus error={create.error ? errorText(create.error) : null} />
        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={create.isPending}>
            {t('create')}
          </Button>
        </div>
      </form>
    </div>
  );
}

const detailsSchema = z.object({
  fullName: fullNameSchema,
  mobile: z.string(),
  preferredLocale: userLocaleSchema,
});

export function EditUser({ userId }: { userId: string }) {
  const t = useTranslations('admin.userForm');
  const tu = useTranslations('admin.users');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const trpc = useTRPC();
  const users = useQuery(trpc.admin.listUsers.queryOptions());
  const user = users.data?.find((u) => u.id === userId);
  if (users.isPending || (!user && users.isFetching)) {
    return <p aria-busy="true">{tc('loading')}</p>;
  }
  if (!user) return <p>{te('notFound')}</p>;
  return (
    <div className="max-w-4xl space-y-5">
      <BackLink />
      <div>
        <h1 className="text-3xl font-semibold">{user.fullName}</h1>
        <p className="font-mono text-muted-foreground">
          {user.username} · {user.isActive ? tu('active') : tu('inactive')}
          {user.isLockedOut && ` · ${tu('lockedOut')}`}
        </p>
      </div>
      <Details key={`d-${user.id}`} user={user} title={t('details')} />
      <Roles key={`r-${user.id}`} userId={user.id} initial={user.roles.map((r) => r.id)} />
      <Actions user={user} />
      <Sessions userId={user.id} />
    </div>
  );
}

type UserRow = inferRouterOutputs<AppRouter>['admin']['listUsers'][number];

function useInvalidateUsers() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: trpc.admin.pathKey() });
}

function Details({ user, title }: { user: UserRow; title: string }) {
  const t = useTranslations('admin.userForm');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const invalidate = useInvalidateUsers();
  const langId = useId();
  const [mobileError, setMobileError] = useState<string>();
  const form = useForm({
    resolver: zodResolver(detailsSchema),
    defaultValues: {
      fullName: user.fullName,
      mobile: user.mobile ?? '',
      preferredLocale: user.preferredLocale === 'en' ? ('en' as const) : ('hi' as const),
    },
  });
  const save = useMutation(
    trpc.admin.updateUser.mutationOptions({ onSuccess: () => void invalidate() }),
  );
  return (
    <Section title={title}>
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) =>
          void form.handleSubmit((v) => {
            const mobile = optionalMobileSchema.safeParse(v.mobile);
            if (!mobile.success) return setMobileError(mobile.error.issues[0]?.message);
            setMobileError(undefined);
            save.mutate({ userId: user.id, ...v, mobile: mobile.data ?? undefined });
          })(e)
        }
      >
        <TextField
          label={t('fullName')}
          error={form.formState.errors.fullName?.message}
          {...form.register('fullName')}
        />
        <TextField
          label={t('mobile')}
          inputMode="numeric"
          error={mobileError}
          {...form.register('mobile')}
        />
        <div className="space-y-2">
          <Label htmlFor={langId}>{t('language')}</Label>
          <LanguageSelect id={langId} {...form.register('preferredLocale')} />
        </div>
        <div className="flex flex-col justify-end gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <FormStatus
            error={save.error ? errorText(save.error) : null}
            success={save.isSuccess ? t('saved') : null}
          />
          <Button type="submit" disabled={save.isPending}>
            {t('saveDetails')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Roles({ userId, initial }: { userId: string; initial: string[] }) {
  const t = useTranslations('admin.userForm');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const invalidate = useInvalidateUsers();
  const [roleIds, setRoleIds] = useState(initial);
  const save = useMutation(
    trpc.admin.setUserRoles.mutationOptions({ onSuccess: () => void invalidate() }),
  );
  return (
    <Section title={t('roles')}>
      <RolePicker value={roleIds} onChange={setRoleIds} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <FormStatus
          error={save.error ? errorText(save.error) : null}
          success={save.isSuccess ? t('saved') : null}
        />
        <Button onClick={() => save.mutate({ userId, roleIds })} disabled={save.isPending}>
          {t('saveRoles')}
        </Button>
      </div>
    </Section>
  );
}

function Actions({ user }: { user: UserRow }) {
  const t = useTranslations('admin.userActions');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const invalidate = useInvalidateUsers();
  const { me } = useSession();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ error?: string; ok?: string } | null>(null);
  const opts = {
    onSuccess: () => {
      setResult({ ok: tc('done') });
      setPassword('');
      setReason('');
      void invalidate();
    },
    onError: (err: unknown) => setResult({ error: errorText(err) }),
  };
  const resetPassword = useMutation(trpc.admin.resetPassword.mutationOptions(opts));
  const resetPin = useMutation(trpc.admin.resetPin.mutationOptions(opts));
  const clearLockout = useMutation(trpc.admin.clearLockout.mutationOptions(opts));
  const resetTotp = useMutation(trpc.admin.resetTotp.mutationOptions(opts));
  const deactivate = useMutation(trpc.admin.deactivateUser.mutationOptions(opts));
  const reactivate = useMutation(trpc.admin.reactivateUser.mutationOptions(opts));
  const self = me.userId === user.id;
  const pwOk = passwordSchema.safeParse(password).success;
  const reasonOk = reasonSchema.safeParse(reason).success;

  const row = (title: string, help: string, control: ReactNode) => (
    <div className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0 md:flex-row md:items-end md:justify-between">
      <div className="max-w-xl">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">{help}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">{control}</div>
    </div>
  );

  return (
    <Section title={t('title')}>
      {self && <p className="font-medium">{t('selfNote')}</p>}
      {row(
        t('resetPassword'),
        t('resetPasswordHelp'),
        <>
          <div className="w-60">
            <TextField
              label={t('newPassword')}
              type="text"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={!pwOk || resetPassword.isPending}
            onClick={() => resetPassword.mutate({ userId: user.id, password })}
          >
            {t('resetPassword')}
          </Button>
        </>,
      )}
      {row(
        t('resetPin'),
        t('resetPinHelp'),
        <Button
          variant="outline"
          disabled={!user.hasPin}
          onClick={() => resetPin.mutate({ userId: user.id })}
        >
          {t('resetPin')}
        </Button>,
      )}
      {row(
        t('clearLockout'),
        t('clearLockoutHelp'),
        <Button
          variant="outline"
          disabled={!user.isLockedOut && !user.isPinLockedOut}
          onClick={() => clearLockout.mutate({ userId: user.id })}
        >
          {t('clearLockout')}
        </Button>,
      )}
      {row(
        t('resetTotp'),
        t('resetTotpHelp'),
        <Button
          variant="outline"
          disabled={!user.totpEnabled}
          onClick={() => resetTotp.mutate({ userId: user.id })}
        >
          {t('resetTotp')}
        </Button>,
      )}
      {user.isActive
        ? row(
            t('deactivate'),
            t('deactivateHelp'),
            <>
              <div className="w-60">
                <TextField
                  label={t('reason')}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={self}
                />
              </div>
              <Button
                variant="destructive"
                disabled={self || !reasonOk || deactivate.isPending}
                onClick={() => deactivate.mutate({ userId: user.id, reason })}
              >
                {t('deactivate')}
              </Button>
            </>,
          )
        : row(
            t('reactivate'),
            '',
            <Button onClick={() => reactivate.mutate({ userId: user.id })}>
              {t('reactivate')}
            </Button>,
          )}
      <FormStatus error={result?.error} success={result?.ok} />
    </Section>
  );
}

function Sessions({ userId }: { userId: string }) {
  const t = useTranslations('admin.sessions');
  const trpc = useTRPC();
  const qc = useQueryClient();
  const sessions = useQuery(trpc.admin.listSessions.queryOptions({ userId }));
  const revoke = useMutation(
    trpc.admin.revokeSession.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.admin.listSessions.queryKey() }),
    }),
  );
  const rows = sessions.data ?? [];
  return (
    <Section title={t('title')}>
      {rows.length === 0 ? (
        <p>{t('empty')}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="tabular-nums">
                <p>
                  {t('started')}: {formatDateTime(s.createdAt)} · {t('lastSeen')}:{' '}
                  {formatDateTime(s.lastSeenAt)}
                </p>
                <p className="text-muted-foreground">
                  {t('workstation')}: {s.workstationName ?? '—'} · {t('where')}:{' '}
                  {s.isRemote ? t('remote') : t('lan')}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => revoke.mutate({ sessionId: s.id })}
                disabled={revoke.isPending}
              >
                {t('revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
