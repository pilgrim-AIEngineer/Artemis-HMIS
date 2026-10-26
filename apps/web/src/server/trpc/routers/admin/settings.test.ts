/** FND-06: facility profile and settings procedures (permission, validation, audit, isolation). */
import { readSetting } from '@hmis/db';
import { accessLog, auditLog, facility } from '@hmis/db/schema';
import { EDITABLE_SETTING_KEYS, FORBIDDEN_TERMS, GENERIC_SETTING_KEYS } from '@hmis/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let admin: TestBrowser;
let adminB: TestBrowser;
let reception: TestBrowser;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  admin = f.browser();
  await admin.login(f.users.admin.username);
  adminB = f.browser();
  await adminB.login(f.users.adminB.username);
  reception = f.browser();
  await reception.login(f.users.reception.username);
});

afterAll(async () => {
  await f.close();
});

describe('settings (FND-06)', () => {
  it('lists every editable key with its editor, value and default', async () => {
    const { items, roleNames } = await admin.call((c) => c.admin.listSettings());
    expect(items.map((i) => i.key).sort()).toEqual([...EDITABLE_SETTING_KEYS].sort());
    expect(items.every((i) => i.isDefault)).toBe(true);
    const row = items.find((i) => i.key === 'opd.followUpValidityDays')!;
    expect(row).toMatchObject({
      group: 'opd',
      value: 7,
      default: 7,
      editor: { kind: 'integer', min: 0, max: 365, paise: false },
    });
    expect(roleNames.reception).toEqual({ en: 'Reception', hi: 'रिसेप्शन' });
    const keys = items.map((i) => i.key);
    expect(keys).not.toContain('queue.displayKey');
    expect(keys).not.toContain('mtp.rules');
    expect(GENERIC_SETTING_KEYS.every((k) => keys.includes(k))).toBe(true);
  });

  it('saves a valid value, reports it as changed, and audits who did it', async () => {
    const res = await admin.call((c) =>
      c.admin.updateSetting({ key: 'opd.followUpValidityDays', value: 10 }),
    );
    expect(res).toEqual({ key: 'opd.followUpValidityDays', value: 10 });
    expect(await readSetting(f.db, f.a.facilityId, 'opd.followUpValidityDays')).toBe(10);
    const { items } = await admin.call((c) => c.admin.listSettings());
    expect(items.find((i) => i.key === 'opd.followUpValidityDays')).toMatchObject({
      value: 10,
      isDefault: false,
    });
    const [audit] = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'setting'), eq(auditLog.changedBy, f.users.admin.id)))
      .orderBy(desc(auditLog.changedAt))
      .limit(1);
    expect(audit).toMatchObject({ action: 'I', facilityId: f.a.facilityId });
    expect(JSON.stringify(audit!.after)).toContain('opd.followUpValidityDays');
  });

  it('rejects values the registry schema refuses, leaving the old value', async () => {
    for (const value of [9999, -1, 'ten', 1.5, null]) {
      const err = await trpcError(
        admin.call((c) => c.admin.updateSetting({ key: 'opd.followUpValidityDays', value })),
      );
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe('validation.invalid');
    }
    expect(await readSetting(f.db, f.a.facilityId, 'opd.followUpValidityDays')).toBe(10);
    // Structured settings are validated too (money is integer paise, never a float).
    const bad = await trpcError(
      admin.call((c) =>
        c.admin.updateSetting({ key: 'billing.refundApprovalAbovePaise', value: 1000.5 }),
      ),
    );
    expect(bad.code).toBe('BAD_REQUEST');
    const ok = await admin.call((c) =>
      c.admin.updateSetting({ key: 'billing.refundApprovalAbovePaise', value: 150_000 }),
    );
    expect(ok.value).toBe(150_000);
  });

  it('refuses hidden keys (secrets, numbering, MTP) and unknown keys', async () => {
    for (const key of ['queue.displayKey', 'mtp.rules', 'numbering.config']) {
      const err = await trpcError(
        admin.call((c) =>
          // @ts-expect-error deliberately outside the typed key list
          c.admin.updateSetting({ key, value: null }),
        ),
      );
      expect(['FORBIDDEN', 'BAD_REQUEST']).toContain(err.code);
    }
    const hidden = await trpcError(
      admin.call((c) => c.admin.updateSetting({ key: 'queue.displayKey', value: 'x'.repeat(40) })),
    );
    expect(hidden.message).toBe('errors.admin.settingNotEditable');
  });

  it('resets a setting by storing the recommended value (no delete)', async () => {
    const res = await admin.call((c) => c.admin.resetSetting({ key: 'opd.followUpValidityDays' }));
    expect(res.value).toBe(7);
    const { items } = await admin.call((c) => c.admin.listSettings());
    expect(items.find((i) => i.key === 'opd.followUpValidityDays')?.isDefault).toBe(true);
  });

  it('stores the print header and accent colour through the same checks', async () => {
    await admin.call((c) =>
      c.admin.updateSetting({
        key: 'print.header',
        value: { nameHi: 'सिटी हॉस्पिटल', taglineEn: 'Care', showRegistrationNos: false },
      }),
    );
    expect(await readSetting(f.db, f.a.facilityId, 'print.header')).toMatchObject({
      nameHi: 'सिटी हॉस्पिटल',
      taglineEn: 'Care',
      taglineHi: '',
      showRegistrationNos: false,
    });
    await admin.call((c) => c.admin.updateSetting({ key: 'ui.accentColor', value: '#1A5FB4' }));
    expect(await readSetting(f.db, f.a.facilityId, 'ui.accentColor')).toBe('#1a5fb4');
    const bad = await trpcError(
      admin.call((c) => c.admin.updateSetting({ key: 'ui.accentColor', value: 'blue' })),
    );
    expect(bad.code).toBe('BAD_REQUEST');
    await admin.call((c) => c.admin.updateSetting({ key: 'ui.accentColor', value: null }));
    expect(await readSetting(f.db, f.a.facilityId, 'ui.accentColor')).toBeNull();
  });

  it('keeps each facility’s settings apart', async () => {
    await admin.call((c) => c.admin.updateSetting({ key: 'opd.freeFollowUps', value: 3 }));
    expect(await readSetting(f.db, f.b.facilityId, 'opd.freeFollowUps')).toBe(1);
    const { items } = await adminB.call((c) => c.admin.listSettings());
    expect(items.find((i) => i.key === 'opd.freeFollowUps')?.value).toBe(1);
  });

  it('is closed to roles without admin.settings.manage', async () => {
    for (const call of [
      () => reception.call((c) => c.admin.listSettings()),
      () => reception.call((c) => c.admin.updateSetting({ key: 'opd.freeFollowUps', value: 2 })),
      () => reception.call((c) => c.admin.getFacility()),
    ]) {
      expect((await trpcError(call())).code).toBe('FORBIDDEN');
    }
  });
});

describe('facility profile (FND-06)', () => {
  it('reads and updates the profile; blanks become null', async () => {
    const before = await admin.call((c) => c.admin.getFacility());
    expect(before.facilityId).toBe(f.a.facilityId);
    await admin.call((c) =>
      c.admin.updateFacility({
        name: ' Sunrise Women’s Hospital ',
        address: '12 Station Road',
        district: 'Lucknow',
        state: 'Uttar Pradesh',
        pincode: '226001',
        phone: '0522 123456',
        gstin: '09abcde1234f1z5',
        drugLicenceNos: ['UP-20-123', 'UP-21-456'],
        shortName: '',
      }),
    );
    const after = await admin.call((c) => c.admin.getFacility());
    expect(after).toMatchObject({
      name: 'Sunrise Women’s Hospital',
      address: '12 Station Road',
      pincode: '226001',
      gstin: '09ABCDE1234F1Z5',
      shortName: null,
      drugLicenceNos: ['UP-20-123', 'UP-21-456'],
    });
    const [audit] = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'facility'), eq(auditLog.rowId, f.a.facilityId)))
      .orderBy(desc(auditLog.changedAt))
      .limit(1);
    expect(audit).toMatchObject({ action: 'U', changedBy: f.users.admin.id });
  });

  it('validates input and never touches another facility', async () => {
    const bad = await trpcError(
      admin.call((c) => c.admin.updateFacility({ name: 'X1', pincode: '12' })),
    );
    expect(bad.code).toBe('BAD_REQUEST');
    await adminB.call((c) => c.admin.updateFacility({ name: 'Other Hospital' }));
    const [a] = await f.db.select().from(facility).where(eq(facility.id, f.a.facilityId));
    const [b] = await f.db.select().from(facility).where(eq(facility.id, f.b.facilityId));
    expect(a!.name).toBe('Sunrise Women’s Hospital');
    expect(b!.name).toBe('Other Hospital');
  });
});

describe('forbidden-term guard on settings (issue #71, D-10)', () => {
  it('rejects forbidden footer text, stores nothing and logs without the text', async () => {
    const phrase = FORBIDDEN_TERMS.find((t) => t.tier === 'always')!.examples[0]!;
    const err = await trpcError(
      admin.call((c) =>
        c.admin.updateSetting({ key: 'print.header', value: { footerNoteEn: phrase } }),
      ),
    );
    expect(err.code).toBe('BAD_REQUEST');
    const stored = await readSetting(f.db, f.a.facilityId, 'print.header');
    expect(JSON.stringify(stored)).not.toContain(phrase);
    const logs = await f.t.owner
      .select()
      .from(accessLog)
      .where(eq(accessLog.entity, 'forbidden_term_rejection'));
    expect(logs.some((l) => l.purpose === 'input_rejected:admin.updateSetting')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(phrase);
  });
});
