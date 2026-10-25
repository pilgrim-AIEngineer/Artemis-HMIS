import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'print',
    include: ['src/**/*.test.ts'],
  },
});
