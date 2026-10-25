/** Loads the repo-root `.env` into `process.env` for CLI scripts (never overrides real env). */
export function loadRootEnv(): void {
  const file = new URL('../../../.env', import.meta.url);
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
