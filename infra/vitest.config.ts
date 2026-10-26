import { defineProject } from 'vitest/config';

// Tests for the ops scripts (OPS-01): shell scripts with stubbed docker, and a real throwaway
// Postgres + backup container for backup / restore drill / rollback.
export default defineProject({
  test: {
    name: 'infra',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
