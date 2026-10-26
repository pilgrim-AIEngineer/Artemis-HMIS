import { defineProject } from 'vitest/config';

// Tests for the ops scripts (OPS-01): shell scripts with stubbed docker, and a real throwaway
// Postgres + backup container for backup / restore drill / rollback.
export default defineProject({
  test: {
    name: 'infra',
    include: ['tests/**/*.test.ts'],
    // Docker builds, restic and extra Postgres containers are heavy: run this project after all
    // the others, including db-perf (not alongside them) so it cannot starve their timing-sensitive DB tests.
    sequence: { groupOrder: 2 },
    // Files share the host's Docker daemon; keep them serial too.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
