import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
    globalSetup: ['../../packages/db/testing/global-setup.ts', './testing/chromium-libs.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
