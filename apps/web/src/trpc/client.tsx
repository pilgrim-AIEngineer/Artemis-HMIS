'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { useState, type ReactNode } from 'react';
import superjson from 'superjson';
import { AUTH_ERRORS, CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth-constants';
import type { AppRouter } from '@/server/trpc/root';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** Broadcast when the server says the session is locked or gone (handled by SessionProvider). */
export const AUTH_EVENT = 'hmis:auth';
export type AuthEventDetail = 'locked' | 'signed-out';

function readCookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function reportAuthError(err: unknown) {
  if (!(err instanceof TRPCClientError)) return;
  const detail: AuthEventDetail | null =
    err.message === AUTH_ERRORS.locked
      ? 'locked'
      : err.message === AUTH_ERRORS.required
        ? 'signed-out'
        : null;
  if (detail) window.dispatchEvent(new CustomEvent<AuthEventDetail>(AUTH_EVENT, { detail }));
}

const isClientError = (err: unknown): boolean => {
  if (!(err instanceof TRPCClientError)) return false;
  const status = (err.data as { httpStatus?: number } | undefined)?.httpStatus;
  return status !== undefined && status < 500;
};

function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportAuthError }),
    mutationCache: new MutationCache({ onError: reportAuthError }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        // Auth errors will not fix themselves by retrying.
        retry: (count, err) => count < 1 && !isClientError(err),
      },
    },
  });
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          // Queries too go by POST: a GET would put the input (a patient's name or mobile in the
          // search box) in the URL, and so in access logs (AGENTS.md rule 15).
          methodOverride: 'POST',
          transformer: superjson,
          // Double-submit CSRF token (set by the proxy on page load).
          headers: () => {
            const token = readCookie(CSRF_COOKIE);
            return token ? { [CSRF_HEADER]: token } : {};
          },
        }),
      ],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
