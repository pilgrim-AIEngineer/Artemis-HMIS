import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'print',
    include: ['src/**/*.test.{ts,tsx}'],
    globalSetup: ['../db/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
