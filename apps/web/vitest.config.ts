import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
      // `server-only` throws outside the react-server condition; tests run on the server anyway.
      'server-only': fileURLToPath(new URL('./test/empty.ts', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['../../packages/db/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
