import { type Tx } from '@hmis/db';
import { sql } from 'drizzle-orm';
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
