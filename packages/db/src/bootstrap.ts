import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { appUser, facility } from '../schema';
import type { Db } from './client';
import { hashSecret } from './password';
import { ensureFacilityRbac, grantRoles } from './rbac';
import { withTx, type Tx } from './tx';

export interface NewUser {
  facilityId: string;
  username: string;
  fullName: string;
  password?: string;
  pin?: string;
  roles?: readonly string[];
  preferredLocale?: 'en' | 'hi';
  mobile?: string | null;
  passwordMustChange?: boolean;
}

/** Inserts a user with hashed password/PIN and role grants, inside the caller's transaction. */
export async function insertUser(tx: Tx, u: NewUser): Promise<string> {
  const id = uuidv7();
  await tx.insert(appUser).values({
    id,
    facilityId: u.facilityId,
    username: u.username,
    fullName: u.fullName,
    mobile: u.mobile ?? null,
    preferredLocale: u.preferredLocale ?? 'en',
    passwordHash: u.password ? await hashSecret(u.password) : null,
    pinHash: u.pin ? await hashSecret(u.pin) : null,
    passwordMustChange: u.passwordMustChange ?? false,
  });
  await grantRoles(tx, u.facilityId, id, u.roles ?? []);
  return id;
}

export interface BootstrapOptions {
  facilityName: string;
  adminUsername: string;
  /** Omit to generate one; it is returned once and must be changed at first login. */
  adminPassword?: string;
}

export interface BootstrapResult {
  facilityId: string;
  createdFacility: boolean;
  admin: { username: string; password: string } | null;
}

/**
 * First-run setup for `pnpm db:seed`: one facility, the default roles/permissions (docs/03) for
 * every facility, and an initial `admin` account when the facility has no users. Idempotent.
 */
export async function bootstrapFacility(db: Db, opts: BootstrapOptions): Promise<BootstrapResult> {
  return withTx({ db, userId: null }, async (tx) => {
    const [first] = await tx
      .select({ id: facility.id })
      .from(facility)
      .orderBy(asc(facility.createdAt))
      .limit(1);
    let facilityId = first?.id;
    const createdFacility = !facilityId;
    if (!facilityId) {
      facilityId = uuidv7();
      await tx.insert(facility).values({ id: facilityId, facilityId, name: opts.facilityName });
    }
    for (const f of await tx.select({ id: facility.id }).from(facility)) {
      await ensureFacilityRbac(tx, f.id);
    }
    const [anyUser] = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.facilityId, facilityId))
      .limit(1);
    let admin: BootstrapResult['admin'] = null;
    if (!anyUser) {
      const password = opts.adminPassword ?? randomBytes(9).toString('base64url');
      await insertUser(tx, {
        facilityId,
        username: opts.adminUsername,
        fullName: 'Administrator',
        password,
        roles: ['admin'],
        passwordMustChange: true,
      });
      admin = { username: opts.adminUsername, password };
    }
    return { facilityId, createdFacility, admin };
  });
}
