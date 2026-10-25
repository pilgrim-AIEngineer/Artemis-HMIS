import type { Context } from '@/server/trpc/init';

/** tRPC context for server-side callers in tests: no cookies, LAN client, real clock. */
export function testContext(overrides: Partial<Context> & Pick<Context, 'db'>): Context {
  return {
    headers: new Headers(),
    resHeaders: new Headers(),
    clientIp: '192.168.1.50',
    now: () => new Date(),
    ...overrides,
  };
}
