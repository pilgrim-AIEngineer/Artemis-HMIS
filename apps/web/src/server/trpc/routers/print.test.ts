/** FND-06: print.begin writes print_log with copy numbers and enforces the template permission. */
import { printLog } from '@hmis/db/schema';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../test/auth-fixture';

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

const sample = 'sample-a4';

describe('print.begin (FND-06, docs/01 §4)', () => {
  it('logs each print with the next copy number and the workstation/user', async () => {
    const entityId = f.a.facilityId;
    expect(await admin.call((c) => c.print.nextCopy({ template: sample, entityId }))).toEqual({
      copyNo: 1,
    });
    const first = await admin.call((c) => c.print.begin({ template: sample, entityId }));
    const second = await admin.call((c) => c.print.begin({ template: sample, entityId }));
    expect([first.copyNo, second.copyNo]).toEqual([1, 2]);
    expect(await admin.call((c) => c.print.nextCopy({ template: sample, entityId }))).toEqual({
      copyNo: 3,
    });
    const rows = await f.db
      .select()
      .from(printLog)
      .where(and(eq(printLog.template, sample), eq(printLog.entityId, entityId)));
    expect(rows.map((r) => r.copyNo).sort()).toEqual([1, 2]);
    expect(rows.every((r) => r.userId === f.users.admin.id && r.entity === 'facility')).toBe(true);
    expect(rows.every((r) => r.facilityId === f.a.facilityId)).toBe(true);
  });

  it('counts copies per template', async () => {
    const r = await admin.call((c) =>
      c.print.begin({ template: 'sample-thermal80', entityId: f.a.facilityId }),
    );
    expect(r.copyNo).toBe(1);
  });

  it('refuses users without the template permission, and logs nothing', async () => {
    const entityId = f.a.facilityId;
    const err = await trpcError(
      reception.call((c) => c.print.begin({ template: sample, entityId })),
    );
    expect(err.code).toBe('FORBIDDEN');
    const next = await trpcError(
      reception.call((c) => c.print.nextCopy({ template: sample, entityId })),
    );
    expect(next.code).toBe('FORBIDDEN');
    const rows = await f.db
      .select()
      .from(printLog)
      .where(eq(printLog.userId, f.users.reception.id));
    expect(rows).toEqual([]);
  });

  it('refuses unknown templates, unknown entities and other facilities’ entities', async () => {
    const unknown = await trpcError(
      admin.call((c) => c.print.begin({ template: 'nope', entityId: f.a.facilityId })),
    );
    expect(unknown.code).toBe('NOT_FOUND');
    const missing = await trpcError(
      admin.call((c) => c.print.begin({ template: sample, entityId: uuidv7() })),
    );
    expect(missing.code).toBe('NOT_FOUND');
    // Facility B's admin may not print facility A's sample (entity = A's facility id).
    const cross = await trpcError(
      adminB.call((c) => c.print.begin({ template: sample, entityId: f.a.facilityId })),
    );
    expect(cross.code).toBe('NOT_FOUND');
  });
});
