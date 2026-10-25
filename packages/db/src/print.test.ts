import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, printLog } from '../schema';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { findPrintCopy, nextCopyNo, recordPrint } from './print';
import { readSetting, writeSetting } from './settings';
import { withTx } from './tx';

let t: PlatformTestDb;
let f: SeededFacility;

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
  f = await seedFacility(t.owner);
});

afterAll(async () => {
  await t.close();
});

const ctx = () => ({ db: t.app, userId: f.userId, facilityId: f.facilityId });
const print = (template: string, entityId: string) =>
  withTx(ctx(), (tx) =>
    recordPrint(tx, {
      facilityId: f.facilityId,
      template,
      entity: 'facility',
      entityId,
      userId: f.userId,
      workstationId: f.workstationId,
    }),
  );

describe('print_log (FND-06, docs/01 §4)', () => {
  it('numbers copies per document: 1 = original, then 2, 3 = DUPLICATE', async () => {
    const id = uuidv7();
    const target = { facilityId: f.facilityId, template: 'sample-a4', entityId: id };
    expect(await nextCopyNo(t.app, target)).toBe(1);
    expect((await print('sample-a4', id)).copyNo).toBe(1);
    expect((await print('sample-a4', id)).copyNo).toBe(2);
    expect((await print('sample-a4', id)).copyNo).toBe(3);
    expect(await nextCopyNo(t.app, target)).toBe(4);
    // Another template or another entity starts again at 1.
    expect((await print('sample-a5', id)).copyNo).toBe(1);
    expect((await print('sample-a4', uuidv7())).copyNo).toBe(1);
  });

  it('gives concurrent prints of one document distinct copy numbers', async () => {
    const id = uuidv7();
    const copies = await Promise.all(Array.from({ length: 12 }, () => print('sample-a4', id)));
    expect(copies.map((c) => c.copyNo).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  it('finds a copy only for the user who printed it', async () => {
    const id = uuidv7();
    await print('sample-a4', id);
    const target = { facilityId: f.facilityId, template: 'sample-a4', entityId: id, copyNo: 1 };
    expect((await findPrintCopy(t.app, { ...target, userId: f.userId }))?.printedAt).toBeInstanceOf(
      Date,
    );
    expect(await findPrintCopy(t.app, { ...target, userId: uuidv7() })).toBeNull();
    expect(await findPrintCopy(t.app, { ...target, userId: f.userId, copyNo: 2 })).toBeNull();
  });

  it('is append-only for the app role and stores the workstation', async () => {
    const id = uuidv7();
    await print('sample-a4', id);
    const [row] = await t.app.select().from(printLog).where(eq(printLog.entityId, id));
    expect(row).toMatchObject({ workstationId: f.workstationId, createdBy: f.userId });
    await expect(t.app.delete(printLog).where(eq(printLog.entityId, id))).rejects.toThrow();
    await expect(
      t.app.update(printLog).set({ copyNo: 9 }).where(eq(printLog.entityId, id)),
    ).rejects.toThrow();
  });
});

describe('writeSetting (FND-06)', () => {
  it('validates against the registry, upserts and audits', async () => {
    const write = (key: 'opd.followUpValidityDays', value: unknown) =>
      withTx(ctx(), (tx) => writeSetting(tx, f.facilityId, key, value));
    expect(await readSetting(t.app, f.facilityId, 'opd.followUpValidityDays')).toBe(7);
    expect(await write('opd.followUpValidityDays', 10)).toBe(10);
    expect(await write('opd.followUpValidityDays', 14)).toBe(14);
    expect(await readSetting(t.app, f.facilityId, 'opd.followUpValidityDays')).toBe(14);
    await expect(write('opd.followUpValidityDays', 9999)).rejects.toThrow();
    // JSON null is stored as jsonb 'null' (an unset accent colour), not SQL NULL.
    await withTx(ctx(), (tx) => writeSetting(tx, f.facilityId, 'ui.accentColor', '#112233'));
    await withTx(ctx(), (tx) => writeSetting(tx, f.facilityId, 'ui.accentColor', null));
    expect(await readSetting(t.app, f.facilityId, 'ui.accentColor')).toBeNull();
    expect(await readSetting(t.app, f.facilityId, 'opd.followUpValidityDays')).toBe(14);
    const audits = await t.app.select().from(auditLog).where(eq(auditLog.tableName, 'setting'));
    expect(audits.filter((a) => a.changedBy === f.userId).length).toBeGreaterThanOrEqual(2);
  });
});
