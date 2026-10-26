/**
 * Out-of-band recovery (D-17, issue #96): `pnpm --filter @hmis/db admin:unlock <username>` on the
 * server (or `docker compose exec worker ...`). Clears every sign-in/PIN throttle of the user and
 * writes `access_log`; no password is involved.
 */
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { accessLog, appUser } from '../schema';
import { createDb } from './client';
import { resolveDatabaseUrl } from './env';
import { loadRootEnv } from './load-root-env';
import { clearAllThrottles } from './login-throttle';
import { withTx } from './tx';

loadRootEnv();
const username = process.argv[2]?.trim();
if (!username) {
  console.error('usage: admin:unlock <username>');
  process.exit(2);
}
const db = createDb({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'hmis-admin-unlock',
  max: 1,
});
try {
  const [user] = await db
    .select({ id: appUser.id, facilityId: appUser.facilityId })
    .from(appUser)
    .where(sql`lower(${appUser.username}) = lower(${username})`)
    .limit(1);
  if (!user) {
    console.error('admin:unlock: no such user');
    process.exitCode = 1;
  } else {
    await withTx({ db, userId: null, facilityId: user.facilityId }, async (tx) => {
      await clearAllThrottles(tx, user.id, new Date());
      await tx.insert(accessLog).values({
        id: uuidv7(),
        facilityId: user.facilityId,
        userId: user.id,
        entity: 'login_throttle',
        entityId: user.id,
        purpose: 'cli_unlock',
      });
    });
    console.log('admin:unlock: cleared');
  }
} finally {
  await db.$client.end();
}
