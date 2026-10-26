import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { checkCsrf } from '../auth/request';
import { createContext, type Context } from './init';
import { appRouter } from './root';

/**
 * `/api/trpc` handler. CSRF is checked before tRPC sees the request, so no mutation (login
 * included) runs for a cross-site or token-less POST. `overrides` lets tests inject a DB/clock.
 */
export function createTrpcHandler(overrides: Partial<Pick<Context, 'db' | 'now'>> = {}) {
  return async (req: Request): Promise<Response> => {
    const csrf = checkCsrf(req);
    if (csrf) {
      return Response.json(
        { error: { message: 'errors.auth.csrf', data: { code: 'FORBIDDEN', httpStatus: 403 } } },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const res = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req,
      router: appRouter,
      // Client sends queries as POST so patient search terms never land in URLs/logs (rule 15).
      allowMethodOverride: true,
      createContext: (opts) => ({ ...createContext(opts), ...overrides }),
      onError({ error, path }) {
        if (error.code === 'INTERNAL_SERVER_ERROR') {
          // IDs/paths only — never inputs (may contain patient data or passwords).
          console.error(
            JSON.stringify({ msg: 'trpc error', path, code: error.code, name: error.cause?.name }),
          );
        }
      },
    });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  };
}
