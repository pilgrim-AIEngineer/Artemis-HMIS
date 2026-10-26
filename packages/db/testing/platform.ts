/**
 * Test-only: a freshly migrated database plus a pool that logs in as a throwaway member of
 * `hmis_app`, so tests exercise the same privileges as the running app.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { appUser, facility, workstation } from '../schema';
import { ensureAppLoginRole } from '../src/app-role';
import { createDb, type Db } from '../src/client';
import { runMigrations } from '../src/migrate';
import { withTx } from '../src/tx';
import { createTestDatabase } from './postgres';

export interface PlatformTestDb {
  /** Migration owner (superuser in tests). */
  owner: Db;
  /** Least-privileged app login. */
  app: Db;
  appUser: string;
  close: () => Promise<void>;
}

/**
 * Tests queue far more transactions than the pool has connections (e.g. 60 concurrent token
 * allocations) while the whole suite loads the machine; the 5 s production timeout would make
 * them flaky.
 */
const TEST_CONNECT_TIMEOUT_MS = 60_000;

export async function setupPlatformDb(adminUrl: string, appPoolMax = 20): Promise<PlatformTestDb> {
  const url = await createTestDatabase(adminUrl);
  const owner = createDb({
    connectionString: url,
    max: 4,
    connectionTimeoutMs: TEST_CONNECT_TIMEOUT_MS,
  });
  await runMigrations(owner);

  const user = `t_app_${randomBytes(5).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  await ensureAppLoginRole(owner, user, password);
  const appUrl = new URL(url);
  appUrl.username = user;
  appUrl.password = password;
  const app = createDb({
    connectionString: appUrl.toString(),
    max: appPoolMax,
    connectionTimeoutMs: TEST_CONNECT_TIMEOUT_MS,
  });

  return {
    owner,
    app,
    appUser: user,
    close: async () => {
      await app.$client.end();
      await owner.$client.end();
      // Roles are cluster-wide: drop ours so a shared HMIS_TEST_DATABASE_URL server stays clean.
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query(`drop role if exists ${pg.escapeIdentifier(user)}`);
      } finally {
        await admin.end();
      }
    },
  };
}

export interface SeededFacility {
  facilityId: string;
  userId: string;
  workstationId: string;
}

/** One facility with one user and one workstation, inserted as "system" (no actor). */
export async function seedFacility(db: Db, name = 'Test Hospital'): Promise<SeededFacility> {
  const facilityId = uuidv7();
  const userId = uuidv7();
  const workstationId = uuidv7();
  await withTx({ db, userId: null }, async (tx) => {
    await tx.insert(facility).values({ id: facilityId, facilityId, name });
    await tx.insert(appUser).values({
      id: userId,
      facilityId,
      username: `user_${randomBytes(4).toString('hex')}`,
      fullName: 'Test User',
    });
    await tx.insert(workstation).values({ id: workstationId, facilityId, name: 'Reception 1' });
  });
  return { facilityId, userId, workstationId };
}
