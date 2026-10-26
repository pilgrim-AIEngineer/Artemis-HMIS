import { roleIdsByKey } from '@hmis/db';
import { appUser, auditLog, session, workstation } from '@hmis/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PASSWORD,
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let admin: TestBrowser;
let adminB: TestBrowser;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  admin = f.browser();
  await admin.login(f.users.admin.username);
  adminB = f.browser();
  await adminB.login(f.users.adminB.username);
});

afterAll(async () => {
  await f.close();
});

const roleId = async (facilityId: string, key: string) =>
  (await roleIdsByKey(f.db, facilityId)).get(key)!;

describe('user management (FND-03)', () => {
  it('creates a user with roles who must change the temporary password', async () => {
    const roleIds = [await roleId(f.a.facilityId, 'cashier')];
    const { id } = await admin.call((c) =>
      c.admin.createUser({
        username: 'cashier_new',
        fullName: 'Asha Verma',
        mobile: '98765 43210',
        preferredLocale: 'hi',
        roleIds,
        password: 'first-pass-1',
      }),
    );
    const list = await admin.call((c) => c.admin.listUsers({ search: 'asha' }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      mobile: '9876543210',
      passwordMustChange: true,
      hasPin: false,
    });
    expect(list[0]?.roles.map((r) => r.key)).toEqual(['cashier']);
    const br = f.browser();
    expect((await br.login('Cashier_New', 'first-pass-1')).next).toBe('change_password');
    expect(br.cookies.get('NEXT_LOCALE')).toBe('hi');
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.createUser({
              username: 'CASHIER_NEW',
              fullName: 'Dup',
              preferredLocale: 'en',
              roleIds: [],
              password: 'first-pass-1',
            }),
          ),
        )
      ).message,
    ).toBe('errors.admin.usernameTaken');
  });

  it('assigns and revokes roles (revocations are kept, not deleted)', async () => {
    const lab = await roleId(f.a.facilityId, 'lab_tech');
    const nurse = await roleId(f.a.facilityId, 'nurse');
    await admin.call((c) =>
      c.admin.setUserRoles({ userId: f.users.nurse.id, roleIds: [nurse, lab] }),
    );
    const br = f.browser();
    await br.login(f.users.nurse.username);
    expect((await br.call((c) => c.auth.me()))?.roles).toEqual(['lab_tech', 'nurse']);
    await admin.call((c) => c.admin.setUserRoles({ userId: f.users.nurse.id, roleIds: [nurse] }));
    expect((await br.call((c) => c.auth.me()))?.permissions).not.toContain('lab.result.enter');
    const audits = await f.db.select().from(auditLog).where(eq(auditLog.tableName, 'user_role'));
    expect(audits.some((a) => a.action === 'U' && a.changedBy === f.users.admin.id)).toBe(true);
  });

  it('deactivates without deleting: sessions end and sign-in fails; reactivation restores', async () => {
    const victim = f.browser();
    await victim.login(f.users.noRoles.username);
    expect(
      (
        await trpcError(
          admin.call((c) => c.admin.deactivateUser({ userId: f.users.noRoles.id, reason: 'x' })),
        )
      ).code,
    ).toBe('BAD_REQUEST');
    await admin.call((c) =>
      c.admin.deactivateUser({ userId: f.users.noRoles.id, reason: 'Left the hospital' }),
    );
    expect(await victim.call((c) => c.auth.me())).toBeNull();
    expect((await trpcError(victim.login(f.users.noRoles.username))).message).toBe(
      'errors.auth.invalidCredentials',
    );
    const [row] = await f.db.select().from(appUser).where(eq(appUser.id, f.users.noRoles.id));
    expect(row).toMatchObject({
      isActive: false,
      deactivatedBy: f.users.admin.id,
      deactivateReason: 'Left the hospital',
    });
    await admin.call((c) => c.admin.reactivateUser({ userId: f.users.noRoles.id }));
    expect((await victim.login(f.users.noRoles.username)).next).toBe('home');
  });

  it('refuses to deactivate yourself or remove the last user manager', async () => {
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.deactivateUser({ userId: f.users.admin.id, reason: 'oops oops' }),
          ),
        )
      ).message,
    ).toBe('errors.admin.cannotDeactivateSelf');
    // Facility B has a single admin.
    const nurseB = await roleId(f.b.facilityId, 'nurse');
    expect(
      (
        await trpcError(
          adminB.call((c) =>
            c.admin.setUserRoles({ userId: f.users.adminB.id, roleIds: [nurseB] }),
          ),
        )
      ).message,
    ).toBe('errors.admin.lastUserManager');
  });

  it('resets PIN and clears lockouts', async () => {
    await f.db
      .update(appUser)
      .set({ lockedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(appUser.id, f.users.reception.id));
    expect(
      (await admin.call((c) => c.admin.listUsers())).find((u) => u.id === f.users.reception.id)
        ?.isLockedOut,
    ).toBe(true);
    await admin.call((c) => c.admin.clearLockout({ userId: f.users.reception.id }));
    await admin.call((c) => c.admin.resetPin({ userId: f.users.reception.id }));
    const br = f.browser();
    await br.login(f.users.reception.username);
    expect((await br.call((c) => c.auth.me()))?.hasPin).toBe(false);
  });

  it('lists live sessions and revokes one', async () => {
    const br = f.browser();
    await br.login(f.users.owner.username);
    const sessions = await admin.call((c) => c.admin.listSessions({ userId: f.users.owner.id }));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    await admin.call((c) => c.admin.revokeSession({ sessionId: sessions[0]!.id }));
    const after = await admin.call((c) => c.admin.listSessions({ userId: f.users.owner.id }));
    expect(after.map((s) => s.id)).not.toContain(sessions[0]!.id);
  });
});

describe('cross-facility access is denied', () => {
  it('lists only own-facility users and sessions', async () => {
    const usersB = await adminB.call((c) => c.admin.listUsers());
    expect(usersB.map((u) => u.id)).toContain(f.users.adminB.id);
    expect(usersB.map((u) => u.id)).not.toContain(f.users.admin.id);
    const sessB = await adminB.call((c) => c.admin.listSessions());
    expect(sessB.every((s) => s.userId === f.users.adminB.id)).toBe(true);
  });

  it('NOT_FOUND for every by-id mutation on another facility’s rows', async () => {
    const target = f.users.reception.id;
    const calls = [
      () => adminB.call((c) => c.admin.resetPassword({ userId: target, password: 'hijack-pass' })),
      () => adminB.call((c) => c.admin.resetPin({ userId: target })),
      () => adminB.call((c) => c.admin.clearLockout({ userId: target })),
      () => adminB.call((c) => c.admin.resetTotp({ userId: target })),
      () =>
        adminB.call((c) => c.admin.deactivateUser({ userId: target, reason: 'cross facility' })),
      () =>
        adminB.call((c) =>
          c.admin.updateUser({ userId: target, fullName: 'Hacked', preferredLocale: 'en' }),
        ),
      () => adminB.call((c) => c.admin.setUserRoles({ userId: target, roleIds: [] })),
      () => adminB.call((c) => c.admin.pairWorkstation({ workstationId: f.a.workstationId })),
      () => adminB.call((c) => c.admin.unpairWorkstation({ workstationId: f.a.workstationId })),
    ];
    for (const call of calls) expect((await trpcError(call())).code).toBe('NOT_FOUND');
    const [s] = await f.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, f.users.admin.id))
      .limit(1);
    expect(
      (await trpcError(adminB.call((c) => c.admin.revokeSession({ sessionId: s!.id })))).code,
    ).toBe('NOT_FOUND');
    const [u] = await f.db.select().from(appUser).where(eq(appUser.id, target));
    expect(u?.fullName).not.toBe('Hacked');
  });

  it('cannot assign another facility’s role', async () => {
    const ownerB = await roleId(f.b.facilityId, 'owner');
    expect(
      (
        await trpcError(
          admin.call((c) => c.admin.setUserRoles({ userId: f.users.nurse.id, roleIds: [ownerB] })),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });

  it('a session whose user moved to another facility is dead', async () => {
    const br = f.browser();
    await br.login(f.users.nurse.username);
    // Bypass the immutability trigger (owner only) to simulate a corrupted/mis-linked row.
    const moveUser = async (facilityId: string) => {
      const c = await f.t.owner.$client.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        await c.query('update app_user set facility_id = $1 where id = $2', [
          facilityId,
          f.users.nurse.id,
        ]);
        await c.query('commit');
      } finally {
        c.release();
      }
    };
    await moveUser(f.b.facilityId);
    try {
      expect(await br.call((c) => c.auth.me())).toBeNull();
      expect((await trpcError(br.call((c) => c.auth.heartbeat()))).code).toBe('UNAUTHORIZED');
    } finally {
      await moveUser(f.a.facilityId);
    }
  });
});

describe('roles and permission matrix', () => {
  it('returns the seeded matrix with restricted keys flagged', async () => {
    const m = await admin.call((c) => c.admin.getRoleMatrix());
    expect(m.permissions.find((p) => p.key === 'mtp.register.view')?.restricted).toBe(true);
    const owner = m.roles.find((r) => r.key === 'owner')!;
    expect(owner.permissions).not.toContain('patient.view.restricted');
    expect(m.roles.find((r) => r.key === 'mtp_doctor')?.permissions).toContain(
      'patient.view.restricted',
    );
  });

  it('edits a custom role; restricted keys cannot be granted or removed here', async () => {
    const { id } = await admin.call((c) =>
      c.admin.createRole({ key: 'vitals_desk', name: 'Vitals desk', nameHi: 'वाइटल्स डेस्क' }),
    );
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.createRole({ key: 'vitals_desk', name: 'Again', nameHi: null }),
          ),
        )
      ).message,
    ).toBe('errors.admin.roleKeyTaken');
    await admin.call((c) =>
      c.admin.setRolePermissions({ roleId: id, permissions: ['vitals.record', 'patient.view'] }),
    );
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.setRolePermissions({
              roleId: id,
              permissions: ['vitals.record', 'mtp.register.view'],
            }),
          ),
        )
      ).message,
    ).toBe('errors.admin.restrictedPermission');
    const mtp = await roleId(f.a.facilityId, 'mtp_doctor');
    // The MTP role is owner-only for an admin, and locked for everyone in this editor.
    expect(
      (
        await trpcError(
          admin.call((c) => c.admin.setRolePermissions({ roleId: mtp, permissions: [] })),
        )
      ).message,
    ).toBe('errors.admin.ownerOnly');
    const owner = f.browser();
    await owner.login(f.users.owner.username);
    expect(
      (
        await trpcError(
          owner.call((c) => c.admin.setRolePermissions({ roleId: mtp, permissions: [] })),
        )
      ).message,
    ).toBe('errors.admin.restrictedPermission');
    const m = await admin.call((c) => c.admin.getRoleMatrix());
    expect(m.roles.find((r) => r.id === id)?.permissions.sort()).toEqual([
      'patient.view',
      'vitals.record',
    ]);
  });

  it('will not strip user management from the only role that has it', async () => {
    const adminRole = await roleId(f.b.facilityId, 'admin');
    expect(
      (
        await trpcError(
          adminB.call((c) =>
            c.admin.setRolePermissions({ roleId: adminRole, permissions: ['admin.audit.view'] }),
          ),
        )
      ).message,
    ).toBe('errors.admin.lastUserManager');
    expect(
      (
        await trpcError(
          adminB.call((c) =>
            c.admin.updateRole({ roleId: adminRole, name: 'Admin', nameHi: null, isActive: false }),
          ),
        )
      ).message,
    ).toBe('errors.admin.lastUserManager');
  });

  it('a deactivated role stops granting at once', async () => {
    const br = f.browser();
    await br.login(f.users.nurse.username);
    const nurse = await roleId(f.a.facilityId, 'nurse');
    await admin.call((c) =>
      c.admin.updateRole({ roleId: nurse, name: 'Nurse', nameHi: 'नर्स', isActive: false }),
    );
    expect((await br.call((c) => c.auth.me()))?.permissions).toEqual([]);
    await admin.call((c) =>
      c.admin.updateRole({ roleId: nurse, name: 'Nurse', nameHi: 'नर्स', isActive: true }),
    );
  });
});

describe('owner-only zone: MTP roles and owner accounts', () => {
  it('an admin cannot grant the MTP role or take over the owner; the owner can', async () => {
    const mtp = await roleId(f.a.facilityId, 'mtp_doctor');
    const nurse = await roleId(f.a.facilityId, 'nurse');
    const ownerOnly = 'errors.admin.ownerOnly';
    // Not to someone else, not to themselves.
    for (const userId of [f.users.nurse.id, f.users.admin.id]) {
      const roles =
        userId === f.users.admin.id ? [await roleId(f.a.facilityId, 'admin'), mtp] : [nurse, mtp];
      expect(
        (await trpcError(admin.call((c) => c.admin.setUserRoles({ userId, roleIds: roles }))))
          .message,
      ).toBe(ownerOnly);
    }
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.createUser({
              username: 'mtp_sneak',
              fullName: 'Sneak',
              preferredLocale: 'en',
              roleIds: [mtp],
              password: 'sneaky-pass-1',
            }),
          ),
        )
      ).message,
    ).toBe(ownerOnly);
    // Owner account: no password reset, PIN/TOTP reset, deactivation or role change by an admin.
    const target = f.users.owner.id;
    for (const call of [
      () => admin.call((c) => c.admin.resetPassword({ userId: target, password: 'takeover-pass' })),
      () => admin.call((c) => c.admin.resetPin({ userId: target })),
      () => admin.call((c) => c.admin.resetTotp({ userId: target })),
      () => admin.call((c) => c.admin.clearLockout({ userId: target })),
      () => admin.call((c) => c.admin.deactivateUser({ userId: target, reason: 'take over' })),
      () => admin.call((c) => c.admin.setUserRoles({ userId: target, roleIds: [] })),
    ]) {
      expect((await trpcError(call())).message).toBe(ownerOnly);
    }
    const ownerRole = await roleId(f.a.facilityId, 'owner');
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.updateRole({ roleId: ownerRole, name: 'Owner', nameHi: null, isActive: false }),
          ),
        )
      ).message,
    ).toBe(ownerOnly);

    // The owner designates the MTP doctor, and the admin then cannot reset that account.
    const owner = f.browser();
    await owner.login(f.users.owner.username);
    await owner.call((c) =>
      c.admin.setUserRoles({ userId: f.users.nurse.id, roleIds: [nurse, mtp] }),
    );
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.admin.resetPassword({ userId: f.users.nurse.id, password: 'takeover-pass' }),
          ),
        )
      ).message,
    ).toBe(ownerOnly);
    // Lifting the MTP account's lockout is owner-only too (it re-opens password guessing).
    expect(
      (await trpcError(admin.call((c) => c.admin.clearLockout({ userId: f.users.nurse.id }))))
        .message,
    ).toBe(ownerOnly);
    await owner.call((c) => c.admin.clearLockout({ userId: f.users.nurse.id }));
    await owner.call((c) => c.admin.setUserRoles({ userId: f.users.nurse.id, roleIds: [nurse] }));
    await admin.call((c) => c.admin.resetPin({ userId: f.users.nurse.id }));
  });

  it('while a facility has no owner, a user manager may designate the first one', async () => {
    const ownerB = await roleId(f.b.facilityId, 'owner');
    const adminRoleB = await roleId(f.b.facilityId, 'admin');
    const { id } = await adminB.call((c) =>
      c.admin.createUser({
        username: 'owner_b',
        fullName: 'Owner B',
        preferredLocale: 'hi',
        roleIds: [ownerB],
        password: 'owner-b-pass',
      }),
    );
    // Now there is one: a second owner, or touching the first, needs the owner.
    expect(
      (
        await trpcError(
          adminB.call((c) =>
            c.admin.setUserRoles({ userId: f.users.adminB.id, roleIds: [adminRoleB, ownerB] }),
          ),
        )
      ).message,
    ).toBe('errors.admin.ownerOnly');
    expect(
      (
        await trpcError(
          adminB.call((c) => c.admin.resetPassword({ userId: id, password: 'takeover-pass' })),
        )
      ).message,
    ).toBe('errors.admin.ownerOnly');
  });
});

describe('workstation pairing', () => {
  it('pairs this browser, tags sessions and audit rows, and redacts the secret', async () => {
    const br = f.browser();
    await br.login(f.users.admin.username);
    const { id } = await br.call((c) =>
      c.admin.createWorkstation({ name: 'Billing 1', location: 'Ground floor' }),
    );
    expect(
      (await trpcError(br.call((c) => c.admin.createWorkstation({ name: 'Billing 1' })))).message,
    ).toBe('errors.admin.workstationNameTaken');
    await br.call((c) => c.admin.pairWorkstation({ workstationId: id }));
    const cookie = br.cookies.get('hmis_ws')!;
    expect(cookie.startsWith(`${id}.`)).toBe(true);
    expect((await br.call((c) => c.auth.me()))?.workstationName).toBe('Billing 1');
    expect(
      (await br.call((c) => c.admin.listWorkstations())).find((w) => w.id === id)?.isThisDevice,
    ).toBe(true);

    // Next sign-in on this browser carries the workstation into the audit trail.
    await br.call((c) => c.auth.logout());
    await br.login(f.users.reception.username);
    const [s] = await f.db
      .select()
      .from(session)
      .where(eq(session.userId, f.users.reception.id))
      .orderBy(desc(session.createdAt))
      .limit(1);
    expect(s?.workstationId).toBe(id);
    const [a] = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'session'), eq(auditLog.rowId, s!.id)));
    expect(a?.workstationId).toBe(id);
    const wsAudit = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'workstation'), eq(auditLog.rowId, id)));
    expect(JSON.stringify(wsAudit)).toContain('[redacted:changed]');
    const [ws] = await f.db.select().from(workstation).where(eq(workstation.id, id));
    expect(JSON.stringify(wsAudit)).not.toContain(ws!.pairingTokenHash!);
  });

  it('a forged or stale pairing cookie is ignored', async () => {
    const br = f.browser();
    br.cookies.set('hmis_ws', `${f.a.workstationId}.forged`);
    await br.login(f.users.reception.username);
    expect((await br.call((c) => c.auth.me()))?.workstationName).toBeNull();
  });

  it('unpairing invalidates the cookie wherever it is', async () => {
    const br = f.browser();
    await br.login(f.users.admin.username);
    await br.call((c) => c.admin.pairWorkstation({ workstationId: f.a.workstationId }));
    await br.call((c) => c.admin.unpairWorkstation({ workstationId: f.a.workstationId }));
    await br.login(f.users.admin.username, PASSWORD);
    expect((await br.call((c) => c.auth.me()))?.workstationName).toBeNull();
  });
});
