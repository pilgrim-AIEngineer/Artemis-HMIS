import { withTx, type Db, type Tx } from '@hmis/db';
import { accessLog } from '@hmis/db/schema';
import { FORBIDDEN_TERM_MESSAGE, isPermission, type Permission } from '@hmis/shared';
import { initTRPC, TRPCError, type TRPCDefaultErrorShape } from '@trpc/server';
import superjson from 'superjson';
import { uuidv7 } from 'uuidv7';
import { ZodError } from 'zod';
import { AUTH_ERRORS } from '@/lib/auth-constants';
import { clientIpFromHeaders } from '../auth/request';
import {
  resolveSession,
  sessionTokenFromHeaders,
  touchSession,
  type AuthSession,
  type SessionState,
} from '../auth/session';
import { getDb } from '../db';

export interface Context {
  /** Lazy so procedures that do not touch the DB work without it. */
  db: () => Db;
  /** Request headers (cookies, user agent). */
  headers: Headers;
  /** Response headers: procedures append `Set-Cookie` here. Null when there is no response. */
  resHeaders: Headers | null;
  clientIp: string | null;
  /** Injectable clock: all lockout/idle/expiry decisions use it. */
  now: () => Date;
}

export function createContext(opts: { req: Request; resHeaders: Headers }): Context {
  return {
    db: getDb,
    headers: opts.req.headers,
    resHeaders: opts.resHeaders,
    clientIp: clientIpFromHeaders(opts.req.headers),
    now: () => new Date(),
  };
}

/**
 * Access rule every procedure must declare via `.meta({ permission })` (docs/02 §7). A
 * permission key needs an active session holding it; the named rules cover auth itself:
 * - `public`: no session (login, health); must expose no patient data;
 * - `session.any`: any live session, whatever its state (logout);
 * - `session.mfa`: only while the TOTP code is pending;
 * - `session.unlock`: locked or active (lock, PIN unlock);
 * - `session.password`: active or forced password change;
 * - `session`: an active session, no particular permission (own account).
 */
export const ACCESS_RULES = {
  public: null,
  'session.any': ['active', 'locked', 'mfa_pending', 'password_change'],
  'session.mfa': ['mfa_pending'],
  'session.unlock': ['active', 'locked'],
  'session.password': ['active', 'password_change'],
  session: ['active'],
} as const satisfies Record<string, readonly SessionState[] | null>;

export type AccessRule = keyof typeof ACCESS_RULES | Permission;

export interface Meta {
  permission: AccessRule;
}

export const isAccessRule = (v: unknown): v is AccessRule =>
  isPermission(v) || (typeof v === 'string' && Object.hasOwn(ACCESS_RULES, v));

/** Carries i18n params for error messages (e.g. lockout minutes) to the client. */
export class AppErrorCause extends Error {
  constructor(readonly params: Record<string, string | number>) {
    super('app error');
    this.name = 'AppErrorCause';
  }
}

/** `TRPCError` whose message is an i18n key (docs/02 §7). */
export const appError = (
  code: TRPCError['code'],
  message: string,
  params?: Record<string, string | number>,
) => new TRPCError({ code, message, cause: params ? new AppErrorCause(params) : undefined });

/** docs/02 §7: never leak SQL/internal errors to the UI; send i18n message keys. */
export function formatError({ shape, error }: { shape: TRPCDefaultErrorShape; error: TRPCError }) {
  const internal = error.code === 'INTERNAL_SERVER_ERROR';
  return {
    ...shape,
    message: internal ? 'errors.internal' : shape.message,
    data: {
      code: shape.data.code,
      httpStatus: shape.data.httpStatus,
      path: shape.data.path,
      zodIssues: error.cause instanceof ZodError ? error.cause.issues : undefined,
      params: error.cause instanceof AppErrorCause ? error.cause.params : undefined,
    },
  };
}

const t = initTRPC.context<Context>().meta<Meta>().create({
  transformer: superjson,
  errorFormatter: formatError,
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

const STATE_ERROR: Record<SessionState, string> = {
  active: AUTH_ERRORS.forbidden,
  locked: AUTH_ERRORS.locked,
  mfa_pending: AUTH_ERRORS.mfaRequired,
  password_change: AUTH_ERRORS.passwordChangeRequired,
};

/** Throws FORBIDDEN unless the session holds `key`. For checks beyond the procedure's meta. */
export function requirePermission(auth: AuthSession, key: Permission): void {
  if (!auth.permissions.has(key)) throw appError('FORBIDDEN', AUTH_ERRORS.forbidden);
}

/**
 * The single gate in front of every procedure: reads `meta.permission`, resolves the session
 * from the cookie, checks state, permission and facility (the session, its user and the
 * facility must match and be active; see `resolveSession`), and marks activity on mutations.
 * A procedure without meta is refused at runtime (and by the router-walk test).
 */
const access = t.middleware(async ({ ctx, meta, type, next }) => {
  const rule = meta?.permission;
  if (!isAccessRule(rule)) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'procedure without permission' });
  }
  if (rule === 'public') return next({ ctx: { ...ctx, auth: null as AuthSession | null } });

  const now = ctx.now();
  const auth = await resolveSession(ctx.db(), sessionTokenFromHeaders(ctx.headers), now);
  if (!auth) throw appError('UNAUTHORIZED', AUTH_ERRORS.required);
  const allowed: readonly SessionState[] = isPermission(rule) ? ['active'] : ACCESS_RULES[rule];
  if (!allowed.includes(auth.state)) {
    throw appError(auth.state === 'active' ? 'FORBIDDEN' : 'UNAUTHORIZED', STATE_ERROR[auth.state]);
  }
  if (isPermission(rule)) requirePermission(auth, rule);
  if (type === 'mutation' && auth.state === 'active') {
    await touchSession(ctx.db(), auth, now);
    auth.lastSeenAt = now;
  }
  return next({ ctx: { ...ctx, auth } });
});

/**
 * Runtime forbidden-term guard, logging half (AGENTS.md rules 7 and 15, D-10): the zod schemas
 * reject the text; this records that a rejection happened (who, which procedure) in `access_log`
 * without the text. Never blocks or alters the response.
 */
const forbiddenTermAudit = t.middleware(async ({ ctx, path, next }) => {
  const result = await next();
  const cause = result.ok ? null : result.error.cause;
  const auth = (ctx as { auth?: AuthSession | null }).auth;
  if (
    auth &&
    cause instanceof ZodError &&
    cause.issues.some((i) => i.message === FORBIDDEN_TERM_MESSAGE)
  ) {
    try {
      await withTx(
        {
          db: ctx.db(),
          userId: auth.userId,
          facilityId: auth.facilityId,
          workstationId: auth.workstationId,
          permissions: [...auth.permissions],
        },
        (tx) =>
          tx.insert(accessLog).values({
            id: uuidv7(),
            facilityId: auth.facilityId,
            userId: auth.userId,
            workstationId: auth.workstationId,
            entity: 'forbidden_term_rejection',
            entityId: uuidv7(),
            purpose: `input_rejected:${path}`,
          }),
      );
    } catch {
      // Logging must not turn a validation error into a 500.
    }
  }
  return result;
});

const base = t.procedure.use(access).use(forbiddenTermAudit);

/** `.meta({ permission: 'public' })` only, for endpoints without patient data. */
export const publicProcedure = base;

/** Business procedures: `.meta({ permission: 'module.action' })`; `ctx.auth` is the session. */
export const protectedProcedure = base.use(({ ctx, next }) => {
  if (!ctx.auth) throw appError('UNAUTHORIZED', AUTH_ERRORS.required);
  const auth = ctx.auth;
  return next({
    ctx: {
      ...ctx,
      auth,
      /** `withTx` with the session as actor: audit rows carry user + workstation (docs/02 §5). */
      tx: <T>(fn: (tx: Tx) => Promise<T>) =>
        withTx(
          {
            db: ctx.db(),
            userId: auth.userId,
            facilityId: auth.facilityId,
            workstationId: auth.workstationId,
            permissions: [...auth.permissions],
          },
          fn,
        ),
    },
  });
});

/** Appends a `Set-Cookie` header to the response (no-op for server-side callers). */
export function setCookie(ctx: Context, cookie: string): void {
  ctx.resHeaders?.append('set-cookie', cookie);
}
