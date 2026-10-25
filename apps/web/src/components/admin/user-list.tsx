'use client';

import { formatDateTime } from '@hmis/shared';
import { Button } from '@hmis/ui/components/button';
import { Input } from '@hmis/ui/components/input';
import { cn } from '@hmis/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDeferredValue, useState, type KeyboardEvent } from 'react';
import { useTRPC } from '@/trpc/client';
import { roleName } from './role-name';

/**
 * Users (FND-03). docs/02 §8 list rules: search focused on load, ↑/↓/Enter, empty state,
 * loading skeleton. Status uses text + colour, never colour alone (docs/05 §4).
 */
export function UserList() {
  const t = useTranslations('admin.users');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const users = useQuery(
    trpc.admin.listUsers.queryOptions(deferred ? { search: deferred } : undefined),
  );
  const [active, setActive] = useState(0);
  const rows = users.data ?? [];

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      router.push(`/admin/users/${rows[active].id}`);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <Button asChild>
          <Link href="/admin/users/new">
            <Plus aria-hidden />
            {t('new')}
          </Link>
        </Button>
      </div>
      <div className="relative max-w-md">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          autoFocus
          aria-label={t('search')}
          placeholder={t('search')}
          className="pl-10"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {users.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-lg">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-secondary">
              <tr>
                <th className="px-4 py-3 font-semibold">{t('name')}</th>
                <th className="px-4 py-3 font-semibold">{t('username')}</th>
                <th className="px-4 py-3 font-semibold">{t('roles')}</th>
                <th className="px-4 py-3 font-semibold">{t('status')}</th>
                <th className="px-4 py-3 font-semibold">{t('lastLogin')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u, i) => (
                <tr
                  key={u.id}
                  aria-selected={i === active}
                  className={cn(
                    'border-t even:bg-muted/40',
                    i === active && 'outline-2 -outline-offset-2 outline-ring',
                  )}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {u.fullName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono">{u.username}</td>
                  <td className="px-4 py-3">
                    {u.roles.length
                      ? u.roles.map((r) => roleName(r, locale)).join(', ')
                      : t('noRoles')}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip
                      label={
                        !u.isActive
                          ? t('inactive')
                          : u.isLockedOut
                            ? t('lockedOut')
                            : u.passwordMustChange
                              ? t('mustChange')
                              : t('active')
                      }
                      tone={
                        !u.isActive
                          ? 'muted'
                          : u.isLockedOut
                            ? 'danger'
                            : u.passwordMustChange
                              ? 'warn'
                              : 'ok'
                      }
                    />
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-sm font-medium',
        tone === 'ok' && 'border-money text-money',
        tone === 'warn' && 'border-primary text-primary',
        tone === 'danger' && 'border-destructive text-destructive',
        tone === 'muted' && 'border-muted-foreground text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}
