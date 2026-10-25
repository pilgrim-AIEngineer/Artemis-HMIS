/**
 * `pnpm db:seed [--demo]`: first-run facility + default roles/permissions (docs/03) + initial
 * admin account. Master data arrives with FND-07 (docs/33-seed-masters.md); `--demo` adds
 * synthetic users (one per role) for training/demo machines (docs/02 §9). Never real patient data.
 *
 * Env: HMIS_FACILITY_NAME (default "Hospital"), HMIS_ADMIN_USERNAME (default "admin"),
 * HMIS_ADMIN_PASSWORD (default: generated and printed once; must be changed at first login),
 * HMIS_DEMO_PASSWORD / HMIS_DEMO_PIN for `--demo` users.
 */
import { ROLE_KEYS } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { appUser } from '../schema';
import { bootstrapFacility, createDb, insertUser, resolveDatabaseUrl, withTx } from '../src';
import { loadRootEnv } from '../src/load-root-env';

const demo = process.argv.includes('--demo');

loadRootEnv();
const db = createDb({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'hmis-seed',
  max: 1,
});
try {
  const res = await bootstrapFacility(db, {
    facilityName: process.env.HMIS_FACILITY_NAME ?? 'Hospital',
    adminUsername: process.env.HMIS_ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.HMIS_ADMIN_PASSWORD || undefined,
  });
  console.log(
    `db:seed: facility ${res.createdFacility ? 'created' : 'present'}; roles and permissions up to date`,
  );
  if (res.admin) {
    console.log(
      `db:seed: initial admin "${res.admin.username}" with password: ${res.admin.password}\n` +
        '         (shown once; a new password is required at first sign-in)',
    );
  }
  if (demo) {
    const password = process.env.HMIS_DEMO_PASSWORD ?? 'demo-pass-2026';
    const pin = process.env.HMIS_DEMO_PIN ?? '2580';
    let created = 0;
    await withTx({ db, userId: null }, async (tx) => {
      for (const roleKey of ROLE_KEYS) {
        const username = `demo_${roleKey}`;
        const [exists] = await tx
          .select({ id: appUser.id })
          .from(appUser)
          .where(and(eq(appUser.facilityId, res.facilityId), eq(appUser.username, username)));
        if (exists) continue;
        await insertUser(tx, {
          facilityId: res.facilityId,
          username,
          fullName: `Demo ${roleKey.replace(/_/g, ' ')}`,
          password,
          pin,
          roles: [roleKey],
        });
        created += 1;
      }
    });
    console.log(
      `db:seed: --demo users demo_<role> (${created} new), password "${password}", PIN ${pin}. ` +
        'Demo/training machines only.',
    );
  }
} finally {
  await db.$client.end();
}
