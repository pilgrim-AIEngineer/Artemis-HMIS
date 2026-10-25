import { createServer } from 'node:net';
import { defineConfig, devices } from '@playwright/test';

/** Free TCP port; never a fixed one, so parallel stacks/CI jobs can share a host. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port')),
      );
    });
  });
}

// Workers inherit process.env, so the port chosen here is shared with them.
process.env.E2E_PORT ??= String(await freePort());
const port = Number(process.env.E2E_PORT);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const isCI = !!process.env.CI;

// docs/32 §1: Chrome at 1366×768 and tablet 1280×800 (touch).
export default defineConfig({
  testDir: './e2e',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure', locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
        isMobile: false,
      },
    },
  ],
  // Requires `pnpm build` first (`pnpm e2e` does it via Turborepo). No DB needed for the smoke.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node e2e/start-standalone.mjs',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' },
      },
});
