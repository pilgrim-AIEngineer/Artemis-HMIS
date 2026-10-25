import { PERMISSIONS, RESTRICTED_PERMISSIONS, ROLE_KEYS, type RoleKey } from '@hmis/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { appUser, permission, role, rolePermission, userRole } from '../schema';
import { seedFacility, setupPlatformDb, type PlatformTestDb } from '../testing/platform';
import { bootstrapFacility, insertUser } from './bootstrap';
import { hashSecret, verifySecret } from './password';
import {
  DEFAULT_ROLE_NAMES,
  DEFAULT_ROLE_PERMISSIONS,
  ensureFacilityRbac,
  loadUserAccess,
  roleIdsByKey,
} from './rbac';
import { readSetting, readSettings } from './settings';
import { withTx } from './tx';

let t: PlatformTestDb;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
});

afterAll(async () => {
  await t.close();
});

const sys = () => ({ db: t.app, userId: null });

describe('default role matrix (docs/03 §3)', () => {
  it('has a bundle and bilingual name for every role key', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual([...ROLE_KEYS].sort());
    for (const k of ROLE_KEYS)
      expect(DEFAULT_ROLE_NAMES[k].hi, k).toMatch(/\p{Script=Devanagari}/u);
  });

  it('grants restricted (MTP) keys only to mtp_doctor', () => {
    for (const [roleKey, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const r = keys.filter((k) => (RESTRICTED_PERMISSIONS as readonly string[]).includes(k));
      expect([...r].sort(), roleKey).toEqual(
        roleKey === 'mtp_doctor' ? [...RESTRICTED_PERMISSIONS].sort() : [],
      );
    }
    expect([...DEFAULT_ROLE_PERMISSIONS.mtp_doctor].sort()).toEqual(
      [...RESTRICTED_PERMISSIONS].sort(),
    );
  });

  it('gives owner everything else, and spot-checks the documented bundles', () => {
    const m = DEFAULT_ROLE_PERMISSIONS;
    expect(m.owner).toHaveLength(PERMISSIONS.length - RESTRICTED_PERMISSIONS.length);
    expect(m.admin).toEqual(expect.arrayContaining(['admin.users.manage', 'patient.merge']));
    expect(m.admin.some((p) => p.startsWith('clinical.'))).toBe(false); // "no clinical edit"
    expect(m.admin).not.toContain('pcpndt.reports.view'); // Form F: pcpndt holders and owner
    expect(m.reception).not.toContain('billing.bill.cancel');
    expect(m.cashier).toEqual(
      expect.arrayContaining(['billing.bill.cancel', 'billing.refund.create']),
    );
    expect(m.pharmacist).not.toContain('pharmacy.stock.adjust');
    expect(m.pathologist).toContain('lab.result.verify');
    expect(m.lab_tech).not.toContain('lab.result.verify');
    expect(m.usg_assistant).toEqual(['usg.report.edit', 'pcpndt.formf.edit']);
    expect(m.auditor.every((p) => p.startsWith('reports.') || p === 'admin.audit.view')).toBe(true);
    for (const keys of Object.values(m)) {
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(PERMISSIONS).toContain(k);
    }
  });
});

describe('ensureFacilityRbac', () => {
  it('seeds permissions, system roles and grants idempotently', async () => {
    const f = await seedFacility(t.owner);
    await withTx(sys(), (tx) => ensureFacilityRbac(tx, f.facilityId));
    await withTx(sys(), (tx) => ensureFacilityRbac(tx, f.facilityId));
    const perms = await t.app
      .select()
      .from(permission)
      .where(eq(permission.facilityId, f.facilityId));
    expect(perms).toHaveLength(PERMISSIONS.length);
    const roles = await t.app.select().from(role).where(eq(role.facilityId, f.facilityId));
    expect(roles.map((r) => r.key).sort()).toEqual([...ROLE_KEYS].sort());
    expect(roles.every((r) => r.isSystem)).toBe(true);
    const grants = await t.app
      .select()
      .from(rolePermission)
      .where(eq(rolePermission.facilityId, f.facilityId));
    const expected = Object.values(DEFAULT_ROLE_PERMISSIONS).reduce((n, k) => n + k.length, 0);
    expect(grants).toHaveLength(expected);
  });

  it('does not re-add a grant an admin revoked', async () => {
    const f = await seedFacility(t.owner);
    await withTx(sys(), (tx) => ensureFacilityRbac(tx, f.facilityId));
    const ids = await roleIdsByKey(t.app, f.facilityId);
    const [p] = await t.app
      .select({ id: permission.id })
      .from(permission)
      .where(and(eq(permission.facilityId, f.facilityId), eq(permission.key, 'vitals.record')));
    await withTx(sys(), (tx) =>
      tx
        .update(rolePermission)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(rolePermission.roleId, ids.get('reception')!),
            eq(rolePermission.permissionId, p!.id),
          ),
        ),
    );
    await withTx(sys(), (tx) => ensureFacilityRbac(tx, f.facilityId));
    const active = await t.app
      .select()
      .from(rolePermission)
      .where(
        and(
          eq(rolePermission.roleId, ids.get('reception')!),
          eq(rolePermission.permissionId, p!.id),
          isNull(rolePermission.revokedAt),
        ),
      );
    expect(active).toHaveLength(0);
  });
});

describe('loadUserAccess', () => {
  it('unions active grants of active roles', async () => {
    const f = await seedFacility(t.owner);
    await withTx(sys(), (tx) => ensureFacilityRbac(tx, f.facilityId));
    const userId = await withTx(sys(), (tx) =>
      insertUser(tx, {
        facilityId: f.facilityId,
        username: `u_${uuidv7().slice(-8)}`,
        fullName: 'Two Roles',
        roles: ['lab_tech', 'nurse'],
      }),
    );
    const access = await loadUserAccess(t.app, userId);
    expect(access.roles).toEqual(['lab_tech', 'nurse']);
    const want = new Set<string>([
      ...DEFAULT_ROLE_PERMISSIONS.lab_tech,
      ...DEFAULT_ROLE_PERMISSIONS.nurse,
    ]);
    expect(access.permissions).toEqual([...want].sort());

    // Revoked user_role and deactivated role both stop granting.
    const ids = await roleIdsByKey(t.app, f.facilityId);
    await withTx(sys(), async (tx) => {
      await tx
        .update(userRole)
        .set({ revokedAt: new Date() })
        .where(and(eq(userRole.userId, userId), eq(userRole.roleId, ids.get('nurse')!)));
      await tx
        .update(role)
        .set({ isActive: false })
        .where(eq(role.id, ids.get('lab_tech')!));
    });
    expect(await loadUserAccess(t.app, userId)).toEqual({ roles: [], permissions: [] });
  });

  it('ignores a role that belongs to another facility', async () => {
    const a = await seedFacility(t.owner, 'A');
    const b = await seedFacility(t.owner, 'B');
    for (const f of [a, b]) await withTx(sys(), (tx) => ensureFacilityRbac(tx, f.facilityId));
    const bOwner = (await roleIdsByKey(t.app, b.facilityId)).get('owner' satisfies RoleKey)!;
    await withTx(sys(), (tx) =>
      tx
        .insert(userRole)
        .values({ id: uuidv7(), facilityId: a.facilityId, userId: a.userId, roleId: bOwner }),
    );
    expect(await loadUserAccess(t.app, a.userId)).toEqual({ roles: [], permissions: [] });
  });
});

describe('bootstrapFacility', () => {
  it('creates facility, roles and a must-change admin only once', async () => {
    const fresh = await setupPlatformDb(inject('testPgAdminUrl'));
    try {
      const first = await bootstrapFacility(fresh.owner, {
        facilityName: 'Demo',
        adminUsername: 'admin',
      });
      expect(first.createdFacility).toBe(true);
      expect(first.admin?.password.length).toBeGreaterThanOrEqual(12);
      const again = await bootstrapFacility(fresh.owner, {
        facilityName: 'Demo',
        adminUsername: 'admin',
      });
      expect(again).toEqual({ facilityId: first.facilityId, createdFacility: false, admin: null });
      const [u] = await fresh.app.select().from(appUser).where(eq(appUser.username, 'admin'));
      expect(u?.passwordMustChange).toBe(true);
      expect(await verifySecret(u!.passwordHash, first.admin!.password)).toBe(true);
      expect((await loadUserAccess(fresh.app, u!.id)).roles).toEqual(['admin']);
    } finally {
      await fresh.close();
    }
  });
});

describe('argon2id secrets', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashSecret('correct horse');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret(h, 'correct horse')).toBe(true);
    expect(await verifySecret(h, 'wrong horse')).toBe(false);
    expect(await verifySecret(null, 'x')).toBe(false);
    expect(await verifySecret('not-a-hash', 'x')).toBe(false);
  });
});

describe('readSettings', () => {
  it('returns stored values and falls back to defaults for unset or invalid ones', async () => {
    const f = await seedFacility(t.owner);
    const { setting } = await import('../schema');
    await withTx(sys(), (tx) =>
      tx.insert(setting).values([
        { facilityId: f.facilityId, key: 'auth.idleLockMinutes', value: 3 },
        { facilityId: f.facilityId, key: 'auth.lockoutMinutes', value: 'bad' },
      ]),
    );
    expect(
      await readSettings(t.app, f.facilityId, [
        'auth.idleLockMinutes',
        'auth.lockoutMinutes',
        'auth.sessionHours',
      ]),
    ).toEqual({ 'auth.idleLockMinutes': 3, 'auth.lockoutMinutes': 15, 'auth.sessionHours': 12 });
    expect(await readSetting(t.app, f.facilityId, 'auth.maxLoginFailures')).toBe(5);
  });
});
