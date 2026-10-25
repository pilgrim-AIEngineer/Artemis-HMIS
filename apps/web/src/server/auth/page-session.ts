import 'server-only';
import type { Permission } from '@hmis/shared';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/auth-constants';
import { getDb } from '../db';
import { resolveSession, type AuthSession } from './session';

/** The session behind this page request (or null). Server Components only. */
export async function getPageSession(): Promise<AuthSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return resolveSession(getDb(), token, new Date());
}

/**
 * For pages inside the app shell. Signed out, or a sign-in step pending → /login. A locked
 * session renders (the client shows the PIN screen over it); pages render no patient data on
 * the server, the tRPC procedures refuse locked sessions.
 */
export async function requirePageSession(): Promise<AuthSession> {
  const auth = await getPageSession();
  if (!auth || auth.state === 'mfa_pending' || auth.state === 'password_change') redirect('/login');
  return auth;
}

/** Cosmetic page guard (the procedures enforce it anyway): no permission → 404. */
export async function requirePagePermission(permission: Permission): Promise<AuthSession> {
  const auth = await requirePageSession();
  if (!auth.permissions.has(permission)) notFound();
  return auth;
}
