/**
 * `pnpm load`: peak-OPD load test (docs/32 §1) against a throwaway stack that mirrors the
 * production image: its own Postgres (Testcontainers, random port), migrations, facility, roles,
 * `db:seed --demo` data (500 patients, 30 days OPD, 50 pregnancies, 80 children) and the
 * standalone Next.js build on a random port, then k6 runs `load/k6/peak-opd.js` and the summary
 * JSON is written to `LOAD_OUT` (default `load/results/<timestamp>.json`).
 *
 * Needs `pnpm build` first and a k6 binary (`K6_BIN`, else `k6` on PATH). Env: SCALE (arrival-rate
 * multiplier, default 1), DURATION (default 10m), USERS (default 15), E2E_DATABASE_URL (superuser URL
 * of an empty database to skip the container). Synthetic data only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureAppLoginRole, withTx } from '@hmis/db';
import { bootstrapFacility, insertUser } from '@hmis/db/auth';
import { runMigrations } from '@hmis/db/migrate';
import { seedMasters } from '@hmis/db/seed';
import { seedDemoData } from '@hmis/db/seed/demo';
import { startPostgresContainer } from '@hmis/db/testing';
import { ROLE_KEYS } from '@hmis/shared';

const web = fileURLToPath(new URL('..', import.meta.url));
const server = `${web}.next/standalone/apps/web/server.js`;
if (!existsSync(server)) {
  console.error('No standalone build found. Run `pnpm build` first.');
  process.exit(1);
}
cpSync(`${web}.next/static`, `${web}.next/standalone/apps/web/.next/static`, { recursive: true });

const k6 = process.env.K6_BIN ?? 'k6';
if (spawnSync(k6, ['version'], { stdio: 'ignore' }).status !== 0) {
  console.error(`k6 not found (${k6}). Install it from https://k6.io or set K6_BIN.`);
  process.exit(1);
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
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

const DEMO_PASSWORD = 'demo-pass-2026';
const pg = process.env.E2E_DATABASE_URL
  ? { url: process.env.E2E_DATABASE_URL, stop: () => Promise.resolve() }
  : await startPostgresContainer();

const owner = createDb({ connectionString: pg.url, max: 2 });
await runMigrations(owner);
const appUser = `load_app_${randomBytes(4).toString('hex')}`;
const appPassword = randomBytes(16).toString('hex');
await ensureAppLoginRole(owner, appUser, appPassword);
const t0 = Date.now();
const res = await bootstrapFacility(owner, {
  facilityName: 'Load Test Hospital',
  adminUsername: 'load_admin',
});
const masters = await withTx({ db: owner, userId: null }, (tx) => seedMasters(tx, res.facilityId));
await withTx({ db: owner, userId: null }, async (tx) => {
  for (const roleKey of ROLE_KEYS) {
    await insertUser(tx, {
      facilityId: res.facilityId,
      username: `demo_${roleKey}`,
      fullName: `Demo ${roleKey}`,
      password: DEMO_PASSWORD,
      pin: '2580',
      roles: [roleKey],
    });
  }
});
const log = await withTx({ db: owner, userId: null }, (tx) =>
  seedDemoData(tx, res.facilityId, masters),
);
console.log(`demo seed (${Math.round((Date.now() - t0) / 1000)} s): ${log.join(' | ')}`);
await owner.$client.end();

const appUrl = new URL(pg.url);
appUrl.username = appUser;
appUrl.password = appPassword;
const port = await freePort();
const filesDir = mkdtempSync(join(tmpdir(), 'hmis-load-files-'));
const app = spawn(process.execPath, [server], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    APP_DATABASE_URL: appUrl.toString(),
    DATABASE_URL: pg.url,
    HMIS_SECRET_KEY: randomBytes(32).toString('hex'),
    HMIS_FILES_DIR: filesDir,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

let code = 1;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    const up = await fetch(`${base}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (i > 120) throw new Error('web did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
  const outDir = join(web, 'load', 'results');
  mkdirSync(outDir, { recursive: true });
  const out =
    process.env.LOAD_OUT ?? join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const run = spawnSync(k6, ['run', join(web, 'load', 'k6', 'peak-opd.js')], {
    stdio: 'inherit',
    env: { ...process.env, BASE_URL: base, SUMMARY_JSON: out, LOAD_PASSWORD: DEMO_PASSWORD },
  });
  code = run.status ?? 1;
  console.log(`summary: ${out}`);
} finally {
  app.kill('SIGTERM');
  rmSync(filesDir, { recursive: true, force: true });
  await pg.stop();
}
process.exit(code);
