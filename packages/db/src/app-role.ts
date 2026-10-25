import pg from 'pg';
import type { Db } from './client';

/** NOLOGIN group role created by migration 0001; runtime logins are members of it. */
export const APP_GROUP_ROLE = 'hmis_app';

/**
 * Creates or updates the app LOGIN role (member of `hmis_app`, no superuser/DDL rights) with the
 * given password. Run as the migration owner after migrations (`pnpm db:migrate`), so the role
 * also appears on databases initialised before FND-04. Never logs the password.
 */
export async function ensureAppLoginRole(db: Db, user: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(user)) throw new Error('Invalid app DB user name');
  if (password.length < 12) throw new Error('App DB password must be at least 12 characters');
  const client = await db.$client.connect();
  try {
    const { rows } = await client.query<{ rolsuper: boolean; is_self: boolean }>(
      'select rolsuper, rolname = current_user as is_self from pg_roles where rolname = $1',
      [user],
    );
    const existing = rows[0];
    if (existing && (existing.rolsuper || existing.is_self)) {
      throw new Error('App DB user must not be a superuser or the migration owner');
    }
    const ident = pg.escapeIdentifier(user);
    const pass = pg.escapeLiteral(password);
    await client.query(
      existing
        ? `alter role ${ident} with login nosuperuser nocreatedb nocreaterole nobypassrls password ${pass}`
        : `create role ${ident} with login nosuperuser nocreatedb nocreaterole nobypassrls password ${pass}`,
    );
    await client.query(`grant ${APP_GROUP_ROLE} to ${ident}`);
  } finally {
    client.release();
  }
}
