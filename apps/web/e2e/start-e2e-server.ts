/**
 * Playwright `webServer`: serves the production standalone build exactly as the Docker image
 * does (infra/docker/web.Dockerfile), against its own throwaway Postgres.
 * - `E2E_DATABASE_URL` (superuser URL of an empty database) skips the container.
 * Steps: start Postgres → migrate → app login role → facility, roles, E2E users → run server.
 * Synthetic users only (e2e/fixtures.ts); nothing here touches other stacks on the host.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, ensureAppLoginRole, ensureFacilityRbac, withTx } from '@hmis/db';
import { insertUser } from '@hmis/db/auth';
import { runMigrations } from '@hmis/db/migrate';
import { facility } from '@hmis/db/schema';
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
});
await owner.$client.end();

const appUrl = new URL(pg.url);
appUrl.username = appUser;
appUrl.password = appPassword;

const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_DATABASE_URL: appUrl.toString(),
    DATABASE_URL: pg.url,
    HMIS_SECRET_KEY: randomBytes(32).toString('hex'),
    NODE_ENV: 'production',
  },
});

const shutdown = () => {
  child.kill('SIGTERM');
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
child.on('exit', (code) => {
  void pg.stop().finally(() => process.exit(code ?? 0));
});
