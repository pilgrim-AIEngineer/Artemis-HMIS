import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts', 'testing/**/*.test.ts'],
    globalSetup: ['./testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
