import { initTRPC, type TRPCDefaultErrorShape, type TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { Db } from '@hmis/db';
import { getDb } from '../db';

export interface Context {
  /** Lazy so procedures that do not touch the DB work without it. */
  db: () => Db;
}

export function createContext(): Context {
  return { db: getDb };
}

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
    },
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: formatError,
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * Unauthenticated procedure. Only for endpoints that expose no patient data (health).
 * Business procedures must use `protectedProcedure` + `requirePermission` (FND-02/03).
 */
export const publicProcedure = t.procedure;
