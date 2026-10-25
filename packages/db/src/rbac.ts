import { PERMISSIONS, RESTRICTED_PERMISSIONS, type Permission, type RoleKey } from '@hmis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { appUser, permission, role, rolePermission, userRole } from '../schema';
import type { Db } from './client';
import type { Tx } from './tx';

type Queryable = Db | Tx;

const restricted: ReadonlySet<string> = new Set(RESTRICTED_PERMISSIONS);
const byPrefix = (...prefixes: string[]): Permission[] =>
  PERMISSIONS.filter((p) => prefixes.some((x) => p.startsWith(x)) && !restricted.has(p));

const REPORTS = byPrefix('reports.');
const RECEPTION_BILLING: Permission[] = [
  'billing.bill.create',
  'billing.bill.finalize',
  'billing.payment.collect',
  'billing.discount.apply',
  'billing.dayclose.own',
];

/**
 * Default role → permission bundles, transcribed from docs/03 §3. Admins may change grants per
 * facility afterwards; `ensureFacilityRbac` never re-adds a grant an admin revoked.
 * `store_keeper` and `pmjay_desk` are Phase 2 roles without a documented bundle: they start empty.
 * Restricted keys (MTP) appear only in `mtp_doctor` (docs/03 §2, §5).
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  owner: PERMISSIONS.filter((p) => !restricted.has(p)),
  admin: [
    ...byPrefix('admin.'),
    ...REPORTS,
    'billing.dayclose.facility',
    'billing.discount.approve',
    'patient.merge',
  ],
  doctor: [
    'patient.view',
    'queue.call',
    'rx.verify',
    'rx.view',
    'order.create',
    ...byPrefix('clinical.'),
    'ipd.order.write',
    'ipd.note.write',
    ...byPrefix('discharge.'),
    'ot.note.write',
    'lr.note.write',
    'reports.clinical',
  ],
  doctor_assistant: [
    'patient.view',
    'queue.call',
    'vitals.record',
    'rx.transcribe',
    'rx.view',
    'order.create',
    'clinical.anc.edit',
    'clinical.paeds.edit',
    'clinical.note.edit',
    'ipd.order.write',
  ],
  reception: [
    'patient.create',
    'patient.update',
    'patient.view',
    'visit.create',
    'queue.manage',
    'queue.call',
    ...RECEPTION_BILLING,
    'vitals.record',
  ],
  cashier: [
    ...RECEPTION_BILLING,
    'billing.deposit.collect',
    'billing.package.apply',
    'billing.ipd.final',
    'billing.refund.create',
    'billing.bill.cancel',
  ],
  nurse: [
    'patient.view',
    'queue.call',
    'vitals.record',
    ...byPrefix('nursing.'),
    'ipd.transfer',
    'inventory.indent',
    'lr.note.write',
    'newborn.register',
  ],
  pharmacist: [
    ...byPrefix('pharmacy.').filter((p) => p !== 'pharmacy.stock.adjust'),
    'inventory.transfer',
    'rx.view',
  ],
  lab_tech: ['lab.sample.collect', 'lab.result.enter'],
  pathologist: ['lab.sample.collect', 'lab.result.enter', 'lab.result.verify'],
  usg_doctor: [...byPrefix('usg.'), ...byPrefix('pcpndt.')],
  usg_assistant: ['usg.report.edit', 'pcpndt.formf.edit'],
  mtp_doctor: [...PERMISSIONS.filter((p) => p.startsWith('mtp.')), 'patient.view.restricted'],
  store_keeper: [],
  pmjay_desk: [],
  auditor: [...REPORTS, 'admin.audit.view'],
};

/** Display names for the seeded system roles (editable afterwards). */
export const DEFAULT_ROLE_NAMES: Record<RoleKey, { en: string; hi: string }> = {
  owner: { en: 'Owner', hi: 'मालिक' },
  admin: { en: 'Administrator', hi: 'प्रशासक' },
  doctor: { en: 'Doctor', hi: 'डॉक्टर' },
  doctor_assistant: { en: "Doctor's assistant", hi: 'डॉक्टर सहायक' },
  reception: { en: 'Reception', hi: 'रिसेप्शन' },
  cashier: { en: 'Cashier', hi: 'कैशियर' },
  nurse: { en: 'Nurse', hi: 'नर्स' },
  pharmacist: { en: 'Pharmacist', hi: 'फार्मासिस्ट' },
  lab_tech: { en: 'Lab technician', hi: 'लैब तकनीशियन' },
  pathologist: { en: 'Pathologist', hi: 'पैथोलॉजिस्ट' },
  usg_doctor: { en: 'USG doctor', hi: 'यूएसजी डॉक्टर' },
  usg_assistant: { en: 'USG assistant', hi: 'यूएसजी सहायक' },
  mtp_doctor: { en: 'MTP doctor', hi: 'एमटीपी डॉक्टर' },
  store_keeper: { en: 'Store keeper', hi: 'स्टोर कीपर' },
  pmjay_desk: { en: 'PM-JAY desk', hi: 'पीएम-जय डेस्क' },
  auditor: { en: 'Auditor', hi: 'ऑडिटर' },
};

export const permissionModule = (key: string): string => key.split('.')[0] ?? key;

/**
 * Idempotently seeds permission keys, system roles and their default grants for a facility.
 * Safe to re-run after an upgrade adds keys: existing rows are left alone and a grant that an
 * admin revoked (a `role_permission` row with `revoked_at`) is not re-created.
 */
export async function ensureFacilityRbac(tx: Tx, facilityId: string): Promise<void> {
  await tx
    .insert(permission)
    .values(
      PERMISSIONS.map((key) => ({ id: uuidv7(), facilityId, key, module: permissionModule(key) })),
    )
    .onConflictDoNothing({ target: [permission.facilityId, permission.key] });
  await tx
    .insert(role)
    .values(
      (Object.keys(DEFAULT_ROLE_PERMISSIONS) as RoleKey[]).map((key) => ({
        id: uuidv7(),
        facilityId,
        key,
        name: DEFAULT_ROLE_NAMES[key].en,
        nameHi: DEFAULT_ROLE_NAMES[key].hi,
        isSystem: true,
      })),
    )
    .onConflictDoNothing({ target: [role.facilityId, role.key] });

  const roles = await tx
    .select({ id: role.id, key: role.key })
    .from(role)
    .where(eq(role.facilityId, facilityId));
  const perms = await tx
    .select({ id: permission.id, key: permission.key })
    .from(permission)
    .where(eq(permission.facilityId, facilityId));
  const existing = await tx
    .select({ roleId: rolePermission.roleId, permissionId: rolePermission.permissionId })
    .from(rolePermission)
    .where(eq(rolePermission.facilityId, facilityId));
  const roleId = new Map(roles.map((r) => [r.key, r.id]));
  const permId = new Map(perms.map((p) => [p.key, p.id]));
  const seen = new Set(existing.map((e) => `${e.roleId}:${e.permissionId}`));

  const grants: (typeof rolePermission.$inferInsert)[] = [];
  for (const [key, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const rid = roleId.get(key);
    if (!rid) continue;
    for (const p of keys) {
      const pid = permId.get(p);
      if (!pid || seen.has(`${rid}:${pid}`)) continue;
      grants.push({ id: uuidv7(), facilityId, roleId: rid, permissionId: pid });
    }
  }
  if (grants.length > 0) await tx.insert(rolePermission).values(grants);
}

export interface UserAccess {
  roles: string[];
  permissions: Permission[];
}

/**
 * Active role keys and the union of their active grants for a user, limited to roles and
 * permissions of the user's own facility (a mis-linked row from another facility grants nothing).
 */
export async function loadUserAccess(q: Queryable, userId: string): Promise<UserAccess> {
  const rows = await q
    .select({ roleKey: role.key, permissionKey: permission.key })
    .from(userRole)
    .innerJoin(appUser, eq(appUser.id, userRole.userId))
    .innerJoin(
      role,
      and(
        eq(role.id, userRole.roleId),
        eq(role.facilityId, appUser.facilityId),
        eq(role.isActive, true),
      ),
    )
    .leftJoin(
      rolePermission,
      and(eq(rolePermission.roleId, role.id), isNull(rolePermission.revokedAt)),
    )
    .leftJoin(
      permission,
      and(
        eq(permission.id, rolePermission.permissionId),
        eq(permission.facilityId, appUser.facilityId),
      ),
    )
    .where(and(eq(userRole.userId, userId), isNull(userRole.revokedAt)));
  const roles = [...new Set(rows.map((r) => r.roleKey))].sort();
  const known: ReadonlySet<string> = new Set(PERMISSIONS);
  const permissions = [
    ...new Set(
      rows.map((r) => r.permissionKey).filter((k): k is Permission => !!k && known.has(k)),
    ),
  ].sort();
  return { roles, permissions };
}

/** For tests and admin tooling: role ids by key for a facility. */
export async function roleIdsByKey(q: Queryable, facilityId: string): Promise<Map<string, string>> {
  const rows = await q
    .select({ id: role.id, key: role.key })
    .from(role)
    .where(eq(role.facilityId, facilityId));
  return new Map(rows.map((r) => [r.key, r.id]));
}

/** Grants roles (by key) to a user; already-active grants are kept. */
export async function grantRoles(
  tx: Tx,
  facilityId: string,
  userId: string,
  roleKeys: readonly string[],
): Promise<void> {
  if (roleKeys.length === 0) return;
  const ids = await roleIdsByKey(tx, facilityId);
  const values = roleKeys.map((k) => {
    const roleId = ids.get(k);
    if (!roleId) throw new Error(`Unknown role ${k}`);
    return { id: uuidv7(), facilityId, userId, roleId };
  });
  await tx
    .insert(userRole)
    .values(values)
    .onConflictDoNothing({
      target: [userRole.userId, userRole.roleId],
      where: sql`${userRole.revokedAt} is null`,
    });
}
