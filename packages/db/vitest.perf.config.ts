import { defineProject } from 'vitest/config';

// Wall-clock budgets (perf/**). Runs after the parallel projects, alone with the CPU.
export default defineProject({
  test: {
    name: 'db-perf',
    include: ['perf/**/*.test.ts'],
    globalSetup: ['./testing/global-setup.ts'],
    sequence: { groupOrder: 1 },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
