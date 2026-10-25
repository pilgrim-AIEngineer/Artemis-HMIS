import { loadUserAccess, type Tx } from '@hmis/db';
import { RESTRICTED_PERMISSIONS } from '@hmis/shared';
import { sql } from 'drizzle-orm';
import type { AuthSession } from '../../../auth/session';
import { appError } from '../../init';

/**
 * Refuses a change that would leave the facility without an active user who can manage users
 * (deactivating or stripping the last admin would lock everyone out of user management).
 * Call at the end of the transaction that made the change.
 */
export async function assertUserManagerRemains(tx: Tx, facilityId: string): Promise<void> {
  const res = await tx.execute<{ n: number }>(sql`
    select count(distinct u.id)::int as n
    from app_user u
    join user_role ur on ur.user_id = u.id and ur.revoked_at is null
    join role r on r.id = ur.role_id and r.is_active and r.facility_id = u.facility_id
    join role_permission rp on rp.role_id = r.id and rp.revoked_at is null
    join permission p on p.id = rp.permission_id and p.facility_id = u.facility_id
    where u.facility_id = ${facilityId} and u.is_active and p.key = 'admin.users.manage'`);
  if ((res.rows[0]?.n ?? 0) < 1) throw appError('CONFLICT', 'errors.admin.lastUserManager');
}

/**
 * Owner-only zone (MTP data is restricted, AGENTS.md rule 8; the owner is the decision maker,
 * docs/40 Q21): roles carrying restricted MTP permissions, the `owner` role itself, and the
 * credentials of users who hold either. Without this, anyone with `admin.users.manage` could
 * grant themselves MTP access or reset the owner's password and sign in as the owner.
 */
const OWNER_ROLE = 'owner';
const restrictedList = sql.join(
  RESTRICTED_PERMISSIONS.map((p) => sql`${p}`),
  sql`, `,
);

const isOwner = (auth: AuthSession) => auth.roles.includes(OWNER_ROLE);

export function assertOwner(auth: AuthSession): void {
  if (!isOwner(auth)) throw appError('FORBIDDEN', 'errors.admin.ownerOnly');
}

/** Of `roleIds`, those that are the owner role or carry an active restricted grant. */
export async function protectedRoleIds(tx: Tx, roleIds: readonly string[]): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set();
  const ids = sql.join(
    roleIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const res = await tx.execute<{ id: string }>(sql`
    select r.id from role r
    where r.id in (${ids})
      and (r.key = ${OWNER_ROLE} or exists (
        select 1 from role_permission rp join permission p on p.id = rp.permission_id
        where rp.role_id = r.id and rp.revoked_at is null and p.key in (${restrictedList})))`);
  return new Set(res.rows.map((r) => r.id));
}

/** True when the user currently holds the owner role or any restricted permission. */
export async function isProtectedUser(tx: Tx, userId: string): Promise<boolean> {
  const access = await loadUserAccess(tx, userId);
  const restricted: readonly string[] = RESTRICTED_PERMISSIONS;
  return (
    access.roles.includes(OWNER_ROLE) || access.permissions.some((p) => restricted.includes(p))
  );
}

/** Credential resets / deactivation of an owner or MTP user need the owner. */
export async function assertMayManageUser(tx: Tx, auth: AuthSession, userId: string) {
  if (userId !== auth.userId && (await isProtectedUser(tx, userId))) assertOwner(auth);
}

async function facilityHasActiveOwner(tx: Tx, facilityId: string): Promise<boolean> {
  const res = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app_user u
    join user_role ur on ur.user_id = u.id and ur.revoked_at is null
    join role r on r.id = ur.role_id and r.is_active and r.key = ${OWNER_ROLE}
    where u.facility_id = ${facilityId} and u.is_active and r.facility_id = u.facility_id`);
  return (res.rows[0]?.n ?? 0) > 0;
}

/**
 * Granting or removing protected roles needs the owner. Bootstrap exception: while the
 * facility has no active owner, a user manager may designate one (owner role only).
 */
export async function assertMayChangeRoles(
  tx: Tx,
  auth: AuthSession,
  added: readonly string[],
  removed: readonly string[],
): Promise<void> {
  if (isOwner(auth)) return;
  const prot = await protectedRoleIds(tx, [...added, ...removed]);
  if (prot.size === 0) return;
  const onlyAddingOwner =
    removed.every((r) => !prot.has(r)) &&
    (
      await tx.execute<{ key: string }>(
        sql`select key from role where id in (${sql.join(
          [...prot].map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      )
    ).rows.every((r) => r.key === OWNER_ROLE);
  if (onlyAddingOwner && !(await facilityHasActiveOwner(tx, auth.facilityId))) return;
  assertOwner(auth);
}
