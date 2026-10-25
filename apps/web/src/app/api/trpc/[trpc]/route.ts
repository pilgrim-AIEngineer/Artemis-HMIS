import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@/server/trpc/init';
import { appRouter } from '@/server/trpc/root';

export const dynamic = 'force-dynamic';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext,
    onError({ error, path }) {
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        // IDs/paths only — never inputs (may contain patient data).
        console.error(
          JSON.stringify({ msg: 'trpc error', path, code: error.code, name: error.cause?.name }),
        );
      }
    },
  });

export { handler as GET, handler as POST };
