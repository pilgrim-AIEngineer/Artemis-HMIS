/**
 * Playwright `webServer`: serves the production standalone build exactly as the Docker image
 * does (infra/docker/web.Dockerfile), against its own throwaway Postgres.
 * - `E2E_DATABASE_URL` (superuser URL of an empty database) skips the container.
 * Steps: start Postgres → migrate → app login role → facility, roles, E2E users → run server.
 * Synthetic users only (e2e/fixtures.ts); nothing here touches other stacks on the host.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureAppLoginRole, ensureFacilityRbac, setServiceRate, withTx } from '@hmis/db';
import { rupeesToPaise } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { insertUser } from '@hmis/db/auth';
import { seedMasters } from '@hmis/db/seed';
import { DEMO_STEPS } from '@hmis/db/seed/demo';
import { runMigrations } from '@hmis/db/migrate';
import { facility, service } from '@hmis/db/schema';
import { startPostgresContainer } from '@hmis/db/testing';
import { uuidv7 } from 'uuidv7';
import { E2E_PASSWORD, E2E_USERS } from './fixtures';

const web = fileURLToPath(new URL('..', import.meta.url));
const server = `${web}.next/standalone/apps/web/server.js`;
if (!existsSync(server)) {
  console.error('No standalone build found. Run `pnpm build` (or `pnpm e2e`, which builds first).');
  process.exit(1);
}
cpSync(`${web}.next/static`, `${web}.next/standalone/apps/web/.next/static`, { recursive: true });

const pg = process.env.E2E_DATABASE_URL
  ? { url: process.env.E2E_DATABASE_URL, stop: () => Promise.resolve() }
  : await startPostgresContainer();

const owner = createDb({ connectionString: pg.url, max: 2 });
await runMigrations(owner);
const appUser = `e2e_app_${randomBytes(4).toString('hex')}`;
const appPassword = randomBytes(16).toString('hex');
await ensureAppLoginRole(owner, appUser, appPassword);
await withTx({ db: owner, userId: null }, async (tx) => {
  const facilityId = uuidv7();
  await tx.insert(facility).values({ id: facilityId, facilityId, name: 'E2E Hospital' });
  await ensureFacilityRbac(tx, facilityId);
  for (const u of Object.values(E2E_USERS)) {
    await insertUser(tx, { facilityId, ...u, password: E2E_PASSWORD, roles: [...u.roles] });
  }
  const masters = await seedMasters(tx, facilityId); // docs/33 master seeds: names only, no rates
  // Demo doctors with consultation rules, and prices for their consultations plus one procedure
  // (billing flows): other services stay unpriced because the masters start from "rate not set".
  // The paediatric follow-up is ₹0, so a follow-up with Dr. Gupta is free (flow 2).
  for (const step of DEMO_STEPS.filter((x) => x.name === 'doctors')) {
    await step.run({ tx, facilityId, masters, rng: () => 0.5 });
  }
  for (const [code, rupees] of [
    ['CONS-GYN-NEW', 500],
    ['CONS-GYN-FU', 300],
    ['CONS-PAED-NEW', 400],
    ['CONS-PAED-FU', 0],
    ['PROC-SUTURE-REM', '350.50'],
    ['PROC-IUCD-INS', 1500],
    // Orders from Rx transcription (flow 4).
    ['LAB-CBC', 300],
    ['LAB-TSH', 450],
    ['USG-OB-EARLY', 900],
  ] as const) {
    const [svc] = await tx
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, facilityId), eq(service.code, code)));
    await setServiceRate(tx, {
      facilityId,
      serviceId: svc!.id,
      tariffId: masters.defaultTariffId,
      ratePaise: rupeesToPaise(rupees),
      effectiveFrom: '2026-04-01',
    });
  }
});
await owner.$client.end();

const appUrl = new URL(pg.url);
appUrl.username = appUser;
appUrl.password = appPassword;

// Rx photos (OPD-02) go to a throwaway files directory, removed on exit.
const filesDir = mkdtempSync(join(tmpdir(), 'hmis-e2e-files-'));

const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_DATABASE_URL: appUrl.toString(),
    DATABASE_URL: pg.url,
    HMIS_SECRET_KEY: randomBytes(32).toString('hex'),
    HMIS_FILES_DIR: filesDir,
    NODE_ENV: 'production',
  },
});

const shutdown = () => {
  child.kill('SIGTERM');
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
child.on('exit', (code) => {
  rmSync(filesDir, { recursive: true, force: true });
  void pg.stop().finally(() => process.exit(code ?? 0));
});
