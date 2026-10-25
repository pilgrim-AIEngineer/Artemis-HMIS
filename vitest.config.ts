import { defineConfig } from 'vitest/config';

// Each package/app has its own vitest.config.ts; `pnpm test` runs them all as projects.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
});
