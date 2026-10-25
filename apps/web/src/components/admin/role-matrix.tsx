'use client';

import type { Permission } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Label } from '@hmis/ui/components/label';
import { cn } from '@hmis/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { FormStatus, TextField } from '@/components/form/text-field';
import { useErrorText } from '@/lib/use-error-text';
import { useTRPC } from '@/trpc/client';
import { roleName } from './role-name';

type ModuleKey = Parameters<ReturnType<typeof useTranslations<'modules'>>>[0];

/**
 * Role → permission editor (FND-03, docs/03 §3). One role at a time, permissions grouped by
 * module. Restricted MTP keys are shown read-only (granted only through the `mtp_doctor` role).
 */
export function RoleMatrix() {
  const t = useTranslations('admin.roles');
  const tm = useTranslations('modules');
  const locale = useLocale();
  const errorText = useErrorText();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const matrix = useQuery(trpc.admin.getRoleMatrix.queryOptions());
  const [roleId, setRoleId] = useState<string | null>(null);
  const selectId = useId();
  const roles = matrix.data?.roles ?? [];
  const role = roles.find((r) => r.id === roleId) ?? roles[0];
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.admin.pathKey() });

  const grouped = useMemo(() => {
    const out = new Map<string, { key: Permission; restricted: boolean }[]>();
    for (const p of matrix.data?.permissions ?? []) {
      out.set(p.module, [...(out.get(p.module) ?? []), { key: p.key, restricted: p.restricted }]);
    }
    return [...out];
  }, [matrix.data]);

  if (matrix.isPending) return <p aria-busy="true">{t('title')}…</p>;
  if (!role) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{t('title')}</h1>
      <div className="max-w-md space-y-2">
        <Label htmlFor={selectId}>{t('role')}</Label>
        <select
          id={selectId}
          className="min-h-11 w-full rounded-md border-2 border-input bg-card px-3 text-base"
          value={role.id}
          onChange={(e) => setRoleId(e.target.value)}
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {roleName(r, locale)} — {r.isSystem ? t('system') : t('custom')}
              {r.isActive ? '' : ` (${t('inactive')})`}
            </option>
          ))}
        </select>
      </div>
      <RoleDetails
        key={`${role.id}-${role.name}-${role.nameHi}-${role.isActive}`}
        role={role}
        onSaved={invalidate}
      />
      <PermissionEditor
        key={`${role.id}:${role.permissions.join(',')}`}
        roleId={role.id}
        initial={role.permissions}
        grouped={grouped}
        moduleLabel={(m) => tm(m as ModuleKey)}
        onSaved={invalidate}
        errorText={errorText}
      />
      <NewRole onCreated={(id) => void invalidate().then(() => setRoleId(id))} />
    </div>
  );
}

function PermissionEditor({
  roleId,
  initial,
  grouped,
  moduleLabel,
  onSaved,
  errorText,
}: {
  roleId: string;
  initial: Permission[];
  grouped: [string, { key: Permission; restricted: boolean }[]][];
  moduleLabel: (m: string) => string;
  onSaved: () => Promise<unknown>;
  errorText: (e: unknown) => string;
}) {
  const t = useTranslations('admin.roles');
  const trpc = useTRPC();
  const [selected, setSelected] = useState<Set<Permission>>(new Set(initial));
  const save = useMutation(
    trpc.admin.setRolePermissions.mutationOptions({ onSuccess: () => void onSaved() }),
  );
  const toggle = (k: Permission, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  return (
    <section aria-labelledby="perm-title" className="space-y-4 rounded-lg border bg-card p-5">
      <h2 id="perm-title" className="text-xl font-semibold">
        {t('permissions')}
      </h2>
      <p className="flex items-center gap-2 text-muted-foreground">
        <Lock aria-hidden className="size-4" />
        {t('restrictedNote')}
      </p>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {grouped.map(([module, perms]) => (
          <fieldset key={module} className="space-y-2 rounded-md border p-3">
            <legend className="px-1 font-semibold">{moduleLabel(module)}</legend>
            {perms.map((p) => (
              <label
                key={p.key}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded px-2',
                  p.restricted ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent',
                )}
              >
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--primary)]"
                  checked={selected.has(p.key)}
                  disabled={p.restricted}
                  onChange={(e) => toggle(p.key, e.target.checked)}
                />
                <span className="font-mono text-sm">{p.key}</span>
                {p.restricted && (
                  <span className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
                    <Lock aria-hidden className="size-3.5" />
                    {t('restricted')}
                  </span>
                )}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <FormStatus
          error={save.error ? errorText(save.error) : null}
          success={save.isSuccess ? t('saved') : null}
        />
        <Button
          onClick={() => save.mutate({ roleId, permissions: [...selected] })}
          disabled={save.isPending}
        >
          {t('save')}
        </Button>
      </div>
    </section>
  );
}

function RoleDetails({
  role,
  onSaved,
}: {
  role: { id: string; name: string; nameHi: string | null; isActive: boolean };
  onSaved: () => Promise<unknown>;
}) {
  const t = useTranslations('admin.roles');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [name, setName] = useState(role.name);
  const [nameHi, setNameHi] = useState(role.nameHi ?? '');
  const [isActive, setActive] = useState(role.isActive);
  const save = useMutation(
    trpc.admin.updateRole.mutationOptions({ onSuccess: () => void onSaved() }),
  );
  return (
    <form
      className="grid max-w-3xl gap-4 rounded-lg border bg-card p-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ roleId: role.id, name, nameHi: nameHi.trim() || null, isActive });
      }}
    >
      <TextField label={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
      <TextField label={t('nameHi')} value={nameHi} onChange={(e) => setNameHi(e.target.value)} />
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5 accent-[var(--primary)]"
          checked={isActive}
          onChange={(e) => setActive(e.target.checked)}
        />
        {t('active')}
      </label>
      <div className="flex items-center justify-end gap-3">
        <FormStatus error={save.error ? errorText(save.error) : null} />
        <Button type="submit" variant="outline" disabled={save.isPending}>
          {t('saveRole')}
        </Button>
      </div>
    </form>
  );
}

function NewRole({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useTranslations('admin.roles');
  const errorText = useErrorText();
  const trpc = useTRPC();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [nameHi, setNameHi] = useState('');
  const create = useMutation(
    trpc.admin.createRole.mutationOptions({
      onSuccess: ({ id }) => {
        setKey('');
        setName('');
        setNameHi('');
        onCreated(id);
      },
    }),
  );
  return (
    <section aria-labelledby="new-role" className="space-y-4 rounded-lg border bg-card p-5">
      <h2 id="new-role" className="text-xl font-semibold">
        {t('newRole')}
      </h2>
      <form
        className="grid max-w-3xl gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ key: key.trim(), name, nameHi: nameHi.trim() || null });
        }}
      >
        <TextField
          label={t('key')}
          value={key}
          autoCapitalize="none"
          onChange={(e) => setKey(e.target.value)}
        />
        <TextField label={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label={t('nameHi')} value={nameHi} onChange={(e) => setNameHi(e.target.value)} />
        <div className="flex items-center justify-between gap-3 sm:col-span-3">
          <FormStatus error={create.error ? errorText(create.error) : null} />
          <Button type="submit" disabled={create.isPending || !key || !name}>
            {t('create')}
          </Button>
        </div>
      </form>
    </section>
  );
}
