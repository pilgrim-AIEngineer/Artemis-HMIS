import { appUser, auditLog, session, setting } from '@hmis/db/schema';
import { withTx } from '@hmis/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createClock,
  HOUR,
  MINUTE,
  PASSWORD,
  PIN,
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../test/auth-fixture';
import { totpCode, totpStep } from '../../auth/totp';

let f: AuthFixture;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
});

afterAll(async () => {
  await f.close();
});

const me = (br: TestBrowser) => br.call((c) => c.auth.me());

async function clearLock(userId: string) {
  await f.db
    .update(appUser)
    .set({ failedLoginCount: 0, lockedUntil: null, pinFailedCount: 0, pinLockedUntil: null })
    .where(eq(appUser.id, userId));
}

describe('login (FND-02)', () => {
  it('signs in, sets a hardened session cookie and the user locale', async () => {
    const br = f.browser();
    const ctx = br.context();
    const { createCaller } = await import('../root');
    const res = await createCaller(ctx).auth.login({
      username: f.users.reception.username,
      password: PASSWORD,
    });
    expect(res.next).toBe('home');
    const cookies = ctx.resHeaders!.getSetCookie();
    const sess = cookies.find((c) => c.startsWith('hmis_session='))!;
    expect(sess).toMatch(/; HttpOnly/);
    expect(sess).toMatch(/; Secure/);
    expect(sess).toMatch(/; SameSite=Lax/);
    expect(sess).toMatch(/; Max-Age=43200/); // 12 h
    expect(cookies.some((c) => c.startsWith('NEXT_LOCALE=en'))).toBe(true);
    br.absorb(cookies);
    const m = await me(br);
    expect(m).toMatchObject({
      username: f.users.reception.username,
      state: 'active',
      hasPin: true,
    });
    expect(m?.permissions).toContain('patient.create');
    // Only the hash is stored.
    const rows = await f.db.select().from(session).where(eq(session.userId, f.users.reception.id));
    expect(rows.some((r) => r.tokenHash === br.cookies.get('hmis_session'))).toBe(false);
  });

  it('is case-insensitive on the username and returns null for no session', async () => {
    const br = f.browser();
    expect(await me(br)).toBeNull();
    await br.login(f.users.nurse.username.toUpperCase());
    expect((await me(br))?.username).toBe(f.users.nurse.username);
  });

  it('gives one message for unknown user, wrong password and inactive user', async () => {
    const br = f.browser();
    for (const [u, p] of [
      ['nobody_here', PASSWORD],
      [f.users.nurse.username, 'wrong-password'],
    ] as const) {
      const err = await trpcError(br.login(u, p));
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.message).toBe('errors.auth.invalidCredentials');
    }
    await clearLock(f.users.nurse.id);
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const clock = createClock();
    const br = f.browser(clock);
    const user = f.users.noRoles.username;
    for (let i = 1; i <= 4; i++) {
      expect((await trpcError(br.login(user, `wrong-${i}`))).message).toBe(
        'errors.auth.invalidCredentials',
      );
    }
    const fifth = await trpcError(br.login(user, 'wrong-5'));
    expect(fifth.code).toBe('TOO_MANY_REQUESTS');
    expect(fifth.message).toBe('errors.auth.lockedOut');
    expect((fifth.cause as unknown as { params: object }).params).toEqual({ minutes: 15 });
    // Even the right password is refused while locked.
    clock.advance(14 * MINUTE);
    const still = await trpcError(br.login(user));
    expect(still.message).toBe('errors.auth.lockedOut');
    expect((still.cause as unknown as { params: object }).params).toEqual({ minutes: 1 });
    clock.advance(1 * MINUTE + 1000);
    expect((await br.login(user)).next).toBe('home');
    const [u] = await f.db.select().from(appUser).where(eq(appUser.id, f.users.noRoles.id));
    expect(u).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it('a new login in the same browser ends the previous session', async () => {
    const br = f.browser();
    await br.login(f.users.nurse.username);
    const first = br.cookies.get('hmis_session')!;
    await br.login(f.users.reception.username);
    const old = f.browser();
    old.cookies.set('hmis_session', first);
    expect(await me(old)).toBeNull();
  });

  it('logout (switch user) revokes the session and clears the cookie', async () => {
    const br = f.browser();
    await br.login(f.users.nurse.username);
    const token = br.cookies.get('hmis_session')!;
    await br.call((c) => c.auth.logout());
    expect(br.cookies.has('hmis_session')).toBe(false);
    const replay = f.browser();
    replay.cookies.set('hmis_session', token);
    expect((await trpcError(replay.call((c) => c.auth.heartbeat()))).message).toBe(
      'errors.auth.required',
    );
  });

  it('audits the session row with the user as actor', async () => {
    const br = f.browser();
    await br.login(f.users.nurse.username);
    const [s] = await f.db
      .select()
      .from(session)
      .where(eq(session.userId, f.users.nurse.id))
      .orderBy(desc(session.createdAt))
      .limit(1);
    const [a] = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'session'), eq(auditLog.rowId, s!.id)));
    expect(a).toMatchObject({ action: 'I', changedBy: f.users.nurse.id });
    expect(a?.after).toMatchObject({ token_hash: '[redacted]' });
  });
});

describe('session lifetime: idle lock → PIN, absolute expiry', () => {
  it('locks after 10 idle minutes; mutations (heartbeat) keep it alive, queries do not', async () => {
    const clock = createClock();
    const br = f.browser(clock);
    await br.login(f.users.reception.username);
    clock.advance(9 * MINUTE);
    await br.call((c) => c.auth.heartbeat());
    clock.advance(9 * MINUTE);
    expect((await me(br))?.state).toBe('active');
    // A background query does not count as activity.
    await br.call((c) => c.auth.me());
    clock.advance(1 * MINUTE + 1000);
    expect((await me(br))?.state).toBe('locked');
    const err = await trpcError(br.call((c) => c.auth.heartbeat()));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('errors.auth.locked');
  });

  it('honours auth.idleLockMinutes from the setting table', async () => {
    const clock = createClock();
    await withTx({ db: f.db, userId: null }, (tx) =>
      tx
        .insert(setting)
        .values({ facilityId: f.b.facilityId, key: 'auth.idleLockMinutes', value: 2 }),
    );
    const br = f.browser(clock);
    await br.login(f.users.adminB.username);
    clock.advance(2 * MINUTE);
    expect((await me(br))?.state).toBe('locked');
    expect((await me(br))?.idleLockMinutes).toBe(2);
  });

  it('unlocks with the same user’s PIN; a wrong PIN says how many tries remain', async () => {
    const clock = createClock();
    const br = f.browser(clock);
    await br.login(f.users.reception.username);
    await br.call((c) => c.auth.lock());
    expect((await me(br))?.state).toBe('locked');
    const wrong = await trpcError(br.call((c) => c.auth.unlockWithPin({ pin: '9999' })));
    expect(wrong.message).toBe('errors.auth.wrongPin');
    expect((wrong.cause as unknown as { params: object }).params).toEqual({ remaining: 4 });
    await br.call((c) => c.auth.unlockWithPin({ pin: PIN }));
    expect((await me(br))?.state).toBe('active');
    const [u] = await f.db.select().from(appUser).where(eq(appUser.id, f.users.reception.id));
    expect(u?.pinFailedCount).toBe(0);
  });

  it('PIN lockout: 5 wrong PINs end the session and block PIN unlock for 15 minutes', async () => {
    const clock = createClock();
    const br = f.browser(clock);
    await br.login(f.users.nurse.username);
    clock.advance(11 * MINUTE);
    for (let i = 0; i < 4; i++) {
      expect((await trpcError(br.call((c) => c.auth.unlockWithPin({ pin: '9753' })))).message).toBe(
        'errors.auth.wrongPin',
      );
    }
    const fifth = await trpcError(br.call((c) => c.auth.unlockWithPin({ pin: '9753' })));
    expect(fifth.message).toBe('errors.auth.pinLockedOut');
    expect(br.cookies.has('hmis_session')).toBe(false);
    // Full sign-in still works (separate lockout), but the PIN stays blocked.
    await br.login(f.users.nurse.username);
    await br.call((c) => c.auth.lock());
    const blocked = await trpcError(br.call((c) => c.auth.unlockWithPin({ pin: PIN })));
    expect(blocked.message).toBe('errors.auth.pinLockedOut');
    expect(await me(br)).toBeNull();
    clock.advance(15 * MINUTE);
    await br.login(f.users.nurse.username);
    await br.call((c) => c.auth.lock());
    await br.call((c) => c.auth.unlockWithPin({ pin: PIN }));
    expect((await me(br))?.state).toBe('active');
  });

  it('a user without a PIN unlocks with the password', async () => {
    const clock = createClock();
    const br = f.browser(clock);
    await br.login(f.users.noPin.username);
    clock.advance(10 * MINUTE);
    expect((await trpcError(br.call((c) => c.auth.unlockWithPin({ pin: PIN })))).message).toBe(
      'errors.auth.pinNotSet',
    );
    expect(
      (await trpcError(br.call((c) => c.auth.unlockWithPassword({ password: 'nope' })))).message,
    ).toBe('errors.auth.wrongPassword');
    await br.call((c) => c.auth.unlockWithPassword({ password: PASSWORD }));
    expect((await me(br))?.state).toBe('active');
    await clearLock(f.users.noPin.id);
  });

  it('expires 12 hours after sign-in however active the user is', async () => {
    const clock = createClock();
    const br = f.browser(clock);
    await br.login(f.users.reception.username);
    for (let elapsed = 0; elapsed < 12 * HOUR - 9 * MINUTE; elapsed += 9 * MINUTE) {
      clock.advance(9 * MINUTE);
      await br.call((c) => c.auth.heartbeat());
    }
    expect((await me(br))?.state).toBe('active');
    clock.advance(9 * MINUTE);
    expect(await me(br)).toBeNull();
    expect((await trpcError(br.call((c) => c.auth.heartbeat()))).message).toBe(
      'errors.auth.required',
    );
  });
});

describe('own account', () => {
  it('setPin needs the password and rejects weak PINs', async () => {
    const br = f.browser();
    await br.login(f.users.noPin.username);
    expect(
      (await trpcError(br.call((c) => c.auth.setPin({ currentPassword: PASSWORD, pin: '1234' }))))
        .code,
    ).toBe('BAD_REQUEST');
    expect(
      (
        await trpcError(
          br.call((c) => c.auth.setPin({ currentPassword: 'wrong-one', pin: '4826' })),
        )
      ).message,
    ).toBe('errors.auth.wrongPassword');
    await br.call((c) => c.auth.setPin({ currentPassword: PASSWORD, pin: '4826' }));
    expect((await me(br))?.hasPin).toBe(true);
    await br.call((c) => c.auth.lock());
    await br.call((c) => c.auth.unlockWithPin({ pin: '4826' }));
    await clearLock(f.users.noPin.id);
  });

  it('setLanguage stores the preference and sets the locale cookie', async () => {
    const br = f.browser();
    await br.login(f.users.nurse.username);
    await br.call((c) => c.auth.setLanguage({ locale: 'hi' }));
    expect(br.cookies.get('NEXT_LOCALE')).toBe('hi');
    expect((await me(br))?.preferredLocale).toBe('hi');
    await br.call((c) => c.auth.setLanguage({ locale: 'en' }));
  });
});

describe('admin password reset → forced change', () => {
  it('ends the user’s sessions and requires a new password after sign-in', async () => {
    const admin = f.browser();
    await admin.login(f.users.admin.username);
    const user = f.browser();
    await user.login(f.users.nurse.username);
    await admin.call((c) =>
      c.admin.resetPassword({ userId: f.users.nurse.id, password: 'temp-pass-777' }),
    );
    expect(await me(user)).toBeNull();
    expect((await user.login(f.users.nurse.username, 'temp-pass-777')).next).toBe(
      'change_password',
    );
    expect((await me(user))?.state).toBe('password_change');
    expect((await trpcError(user.call((c) => c.auth.heartbeat()))).message).toBe(
      'errors.auth.passwordChangeRequired',
    );
    expect(
      (
        await trpcError(
          user.call((c) =>
            c.auth.changePassword({
              currentPassword: 'temp-pass-777',
              newPassword: 'temp-pass-777',
            }),
          ),
        )
      ).message,
    ).toBe('errors.auth.passwordReused');
    await user.call((c) =>
      c.auth.changePassword({ currentPassword: 'temp-pass-777', newPassword: PASSWORD }),
    );
    expect((await me(user))?.state).toBe('active');
  });
});

describe('TOTP for owner/admin remote access', () => {
  const REMOTE_IP = '100.88.1.7'; // Tailscale
  let secret = '';

  it('refuses a remote owner sign-in until TOTP is enrolled', async () => {
    const br = f.browser();
    br.clientIp = REMOTE_IP;
    const err = await trpcError(br.login(f.users.owner.username));
    expect(err.message).toBe('errors.auth.totpNotEnrolled');
    expect(br.cookies.has('hmis_session')).toBe(false);
  });

  it('treats an unknown client address as remote', async () => {
    const br = f.browser();
    br.clientIp = null;
    expect((await trpcError(br.login(f.users.admin.username))).message).toBe(
      'errors.auth.totpNotEnrolled',
    );
  });

  it('enrols from the LAN with password + first code', async () => {
    const br = f.browser();
    await br.login(f.users.owner.username);
    expect((await me(br))?.totpRequired).toBe(true);
    const started = await br.call((c) => c.auth.startTotpEnrolment({ currentPassword: PASSWORD }));
    secret = started.secret;
    expect(started.uri).toMatch(/^otpauth:\/\/totp\/HMIS%3A/);
    expect(started.qrSvg).toMatch(/^<svg/);
    const [u] = await f.db.select().from(appUser).where(eq(appUser.id, f.users.owner.id));
    expect(u?.totpSecretEnc).not.toContain(secret); // sealed at rest
    expect(
      (await trpcError(br.call((c) => c.auth.confirmTotpEnrolment({ code: '000000' })))).message,
    ).toBe('errors.auth.totpInvalid');
    const code = totpCode(secret, totpStep(new Date()));
    await br.call((c) => c.auth.confirmTotpEnrolment({ code }));
    expect((await me(br))?.totpEnabled).toBe(true);
  });

  it('remote sign-in needs the code; the session is unusable until then; codes are single-use', async () => {
    const clock = createClock();
    clock.advance(2 * MINUTE); // past the enrolment step
    const br = f.browser(clock);
    br.clientIp = REMOTE_IP;
    expect((await br.login(f.users.owner.username)).next).toBe('totp');
    expect((await me(br))?.state).toBe('mfa_pending');
    expect((await trpcError(br.call((c) => c.admin.listUsers()))).message).toBe(
      'errors.auth.mfaRequired',
    );
    expect((await trpcError(br.call((c) => c.auth.verifyTotp({ code: '123456' })))).message).toBe(
      'errors.auth.totpInvalid',
    );
    const code = totpCode(secret, totpStep(clock.now));
    expect((await br.call((c) => c.auth.verifyTotp({ code }))).next).toBe('home');
    const m = await me(br);
    expect(m).toMatchObject({ state: 'active', isRemote: true });
    // Replay of the same code on a fresh remote sign-in is refused.
    const again = f.browser(clock);
    again.clientIp = REMOTE_IP;
    await again.login(f.users.owner.username);
    expect((await trpcError(again.call((c) => c.auth.verifyTotp({ code })))).message).toBe(
      'errors.auth.totpInvalid',
    );
    await clearLock(f.users.owner.id);
  });

  it('LAN sign-in of the same owner needs no code; remote reception needs none either', async () => {
    const br = f.browser();
    expect((await br.login(f.users.owner.username)).next).toBe('home');
    const rec = f.browser();
    rec.clientIp = REMOTE_IP;
    expect((await rec.login(f.users.reception.username)).next).toBe('home');
  });

  it('wrong codes count towards the password lockout', async () => {
    const clock = createClock();
    clock.advance(4 * MINUTE);
    const br = f.browser(clock);
    br.clientIp = REMOTE_IP;
    await br.login(f.users.owner.username);
    for (let i = 0; i < 4; i++)
      await trpcError(br.call((c) => c.auth.verifyTotp({ code: '111111' })));
    const fifth = await trpcError(br.call((c) => c.auth.verifyTotp({ code: '111111' })));
    expect(fifth.message).toBe('errors.auth.lockedOut');
    expect(br.cookies.has('hmis_session')).toBe(false);
    await clearLock(f.users.owner.id);
  });
});
