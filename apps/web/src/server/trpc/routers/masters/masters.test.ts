import { withTx } from '@hmis/db';
import { accessLog, auditLog, labTest, serviceRate } from '@hmis/db/schema';
import { FORBIDDEN_TERMS } from '@hmis/shared';
import { seedMasters } from '@hmis/db/seed';
import { and, eq } from 'drizzle-orm';
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
let defaultTariffId: string;
let selfPayerId: string;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  const seeded = await withTx({ db: f.db, userId: null }, async (tx) => {
    await seedMasters(tx, f.b.facilityId);
    return seedMasters(tx, f.a.facilityId);
  });
  defaultTariffId = seeded.defaultTariffId;
  selfPayerId = seeded.selfPayerId;
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

const svc = async (code: string) => {
  const { rows } = await admin.call((c) => c.masters.listServices({ search: code, limit: 50 }));
  const hit = rows.find((r) => r.code === code);
  if (!hit) throw new Error(`service ${code} not found`);
  return hit;
};

describe('masters access (AGENTS.md rule 6)', () => {
  it('refuses reception on masters and rates', async () => {
    for (const call of [
      () => reception.call((c) => c.masters.listServices({})),
      () => reception.call((c) => c.masters.listDrugs({})),
      () => reception.call((c) => c.masters.listServiceRates({ tariffId: defaultTariffId })),
      () =>
        reception.call((c) =>
          c.masters.createDepartment({
            name: 'Hack',
            code: 'HACK',
            isClinical: true,
            isActive: true,
            sortOrder: 1,
          }),
        ),
    ]) {
      expect((await trpcError(call())).code).toBe('FORBIDDEN');
    }
  });
});

describe('departments: create, edit, soft-cancel, restore (audited)', () => {
  let id: string;

  it('creates and rejects a duplicate code', async () => {
    ({ id } = await admin.call((c) =>
      c.masters.createDepartment({
        name: 'Dental',
        nameHi: 'दंत',
        code: 'dent',
        isClinical: true,
        isActive: true,
        sortOrder: 90,
      }),
    ));
    const err = await trpcError(
      admin.call((c) =>
        c.masters.createDepartment({
          name: 'Dental 2',
          code: 'DENT',
          isClinical: true,
          isActive: true,
          sortOrder: 1,
        }),
      ),
    );
    expect(err).toMatchObject({ code: 'CONFLICT', message: 'errors.masters.codeTaken' });
  });

  it('edits, then cancels only with a reason and hides the row by default', async () => {
    await admin.call((c) =>
      c.masters.updateDepartment({
        id,
        name: 'Dental care',
        code: 'DENT',
        isClinical: true,
        isActive: true,
        sortOrder: 90,
      }),
    );
    await expect(
      admin.call((c) => c.masters.cancelDepartment({ id, reason: ' ' })),
    ).rejects.toThrow();
    await admin.call((c) => c.masters.cancelDepartment({ id, reason: 'Not offered here' }));

    const visible = await admin.call((c) => c.masters.listDepartments({ search: 'dental' }));
    expect(visible.rows).toHaveLength(0);
    const all = await admin.call((c) =>
      c.masters.listDepartments({ search: 'dental', includeCancelled: true }),
    );
    expect(all.rows[0]).toMatchObject({
      id,
      status: 'cancelled',
      cancelReason: 'Not offered here',
      cancelledBy: f.users.admin.id,
    });
    expect(all.rows[0]?.cancelledAt).toBeInstanceOf(Date);

    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.masters.updateDepartment({
              id,
              name: 'X1',
              code: 'DENT',
              isClinical: true,
              isActive: true,
              sortOrder: 1,
            }),
          ),
        )
      ).message,
    ).toBe('errors.masters.cancelled');
    expect(
      (await trpcError(admin.call((c) => c.masters.cancelDepartment({ id, reason: 'again' }))))
        .message,
    ).toBe('errors.masters.cancelled');
  });

  it('restores a cancelled row', async () => {
    await admin.call((c) => c.masters.restoreDepartment({ id }));
    const { rows } = await admin.call((c) => c.masters.listDepartments({ search: 'dental' }));
    expect(rows[0]).toMatchObject({ status: 'active', cancelReason: null, cancelledAt: null });
    expect((await trpcError(admin.call((c) => c.masters.restoreDepartment({ id })))).message).toBe(
      'errors.masters.notCancelled',
    );
  });

  it('wrote I, U, U(cancel), U(restore) audit rows attributed to the admin', async () => {
    const rows = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'department'), eq(auditLog.rowId, id)))
      .orderBy(auditLog.changedAt, auditLog.id);
    expect(rows.map((r) => r.action)).toEqual(['I', 'U', 'U', 'U']);
    expect(rows.every((r) => r.changedBy === f.users.admin.id)).toBe(true);
    expect(rows[2]?.after).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'Not offered here',
    });
  });

  it('cannot cancel a department that active doctors or services use', async () => {
    const { rows } = await admin.call((c) => c.masters.listDepartments({ search: 'pathology' }));
    const err = await trpcError(
      admin.call((c) => c.masters.cancelDepartment({ id: rows[0]!.id, reason: 'try' })),
    );
    expect(err.message).toBe('errors.masters.inUse');
  });
});

describe('facility isolation', () => {
  it('never shows or touches another facility’s rows', async () => {
    const mine = await admin.call((c) => c.masters.listDepartments({ limit: 200 }));
    const theirs = await adminB.call((c) => c.masters.listDepartments({ limit: 200 }));
    const ids = new Set(mine.rows.map((r) => r.id));
    expect(theirs.rows.length).toBeGreaterThan(0);
    expect(theirs.rows.every((r) => !ids.has(r.id))).toBe(true);
    const err = await trpcError(
      adminB.call((c) => c.masters.cancelDepartment({ id: mine.rows[0]!.id, reason: 'cross' })),
    );
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('search and paging', () => {
  it('finds by name, short code, Hindi name and typo', async () => {
    const top = async (q: string) =>
      (await admin.call((c) => c.masters.listServices({ search: q, limit: 3 }))).rows.map(
        (r) => r.code,
      );
    expect((await top('nst'))[0]).toBe('PROC-NST');
    expect(await top('ipd')).toEqual(expect.any(Array));
    expect((await top('colposcpy'))[0]).toBe('PROC-COLPO');
    expect((await top('कोल्पोस्कोपी'))[0]).toBe('PROC-COLPO');
    expect((await top('Gynae consultation'))[0]).toMatch(/^CONS-GYN/);
  });

  it('pages through the whole list with a keyset cursor, no gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { rows: { code: string }[]; nextCursor: string | null } = await admin.call((c) =>
        c.masters.listServices({ limit: 25, cursor }),
      );
      seen.push(...page.rows.map((r) => r.code));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(seen.length);
    const everything = await admin.call((c) => c.masters.listServices({ limit: 200 }));
    expect(seen).toEqual(everything.rows.map((r) => r.code));
  });

  it('filters by category', async () => {
    const { rows } = await admin.call((c) =>
      c.masters.listServices({ category: 'usg', limit: 200 }),
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.category === 'usg')).toBe(true);
  });

  it('rejects a tampered cursor', async () => {
    const err = await trpcError(
      admin.call((c) => c.masters.listServices({ cursor: 'not-a-cursor' })),
    );
    expect(err.message).toBe('errors.masters.invalid');
  });
});

describe('payers and tariffs', () => {
  it('only Cash / Self can be active in Phase 1', async () => {
    const base = {
      name: 'PM-JAY',
      code: 'pmjay',
      type: 'pmjay' as const,
      creditDays: 0,
      requiresPreauth: true,
    };
    const err = await trpcError(
      admin.call((c) => c.masters.createPayer({ ...base, isActive: true })),
    );
    expect(err.message).toBe('errors.masters.payerPhase');
    const { id } = await admin.call((c) => c.masters.createPayer({ ...base, isActive: false }));
    const { rows } = await admin.call((c) => c.masters.listPayers({}));
    expect(rows.map((r) => [r.code, r.isActive]).sort()).toEqual([
      ['CASH', true],
      ['PMJAY', false],
    ]);
    // The structure is ready: a payer-specific tariff can be prepared while the payer is off.
    const t = await admin.call((c) =>
      c.masters.createTariff({
        name: 'PM-JAY HBP',
        payerId: id,
        effectiveFrom: '2026-04-01',
        isActive: true,
      }),
    );
    expect(t.id).toBeTruthy();
  });

  it('protects the Cash payer and the default tariff', async () => {
    for (const p of [
      admin.call((c) => c.masters.cancelPayer({ id: selfPayerId, reason: 'oops' })),
      admin.call((c) =>
        c.masters.updatePayer({
          id: selfPayerId,
          name: 'Cash / Self',
          code: 'CASH',
          type: 'self',
          creditDays: 0,
          requiresPreauth: false,
          isActive: false,
        }),
      ),
    ]) {
      expect((await trpcError(p)).message).toBe('errors.masters.selfPayerProtected');
    }
    expect(
      (
        await trpcError(
          admin.call((c) => c.masters.cancelTariff({ id: defaultTariffId, reason: 'oops' })),
        )
      ).message,
    ).toBe('errors.masters.defaultTariffProtected');
  });

  it('rejects tariff dates out of order and unknown payers', async () => {
    await expect(
      admin.call((c) =>
        c.masters.createTariff({
          name: 'Bad',
          effectiveFrom: '2026-05-01',
          effectiveTo: '2026-04-01',
          isActive: true,
        }),
      ),
    ).rejects.toThrow();
    const err = await trpcError(
      admin.call((c) =>
        c.masters.createTariff({
          name: 'Ghost',
          payerId: '0190f0a0-0000-7000-8000-000000000009',
          effectiveFrom: '2026-04-01',
          isActive: true,
        }),
      ),
    );
    expect(err.message).toBe('errors.masters.badReference');
  });
});

describe('services, lab tests and links', () => {
  it('rejects an exempt service with GST and keeps GST in basis points', async () => {
    await expect(
      admin.call((c) =>
        c.masters.createService({
          code: 'x-gst',
          name: 'Taxed',
          category: 'misc',
          isExempt: true,
          defaultGstRateBp: 500,
          unit: 'per_unit',
          isActive: true,
        }),
      ),
    ).rejects.toThrow();
    const { id } = await admin.call((c) =>
      c.masters.createService({
        code: 'x-gst',
        name: 'Taxed misc',
        category: 'misc',
        isExempt: false,
        defaultGstRateBp: 500,
        unit: 'per_unit',
        isActive: true,
      }),
    );
    const { rows } = await admin.call((c) => c.masters.listServices({ search: 'taxed misc' }));
    expect(rows.find((r) => r.id === id)).toMatchObject({ defaultGstRateBp: 500, code: 'X-GST' });
  });

  it('keeps lab_test.service_id in step with the service link', async () => {
    const tests = await admin.call((c) => c.masters.listLabTests({ search: 'tsh' }));
    const tsh = tests.rows.find((r) => r.code === 'TSH')!;
    const { id } = await admin.call((c) =>
      c.masters.createService({
        code: 'lab-tsh-2',
        name: 'TSH (rapid)',
        category: 'lab',
        isExempt: true,
        defaultGstRateBp: 0,
        unit: 'per_unit',
        isActive: true,
        linkedLabTestId: tsh.id,
      }),
    );
    const [row] = await f.db
      .select({ serviceId: labTest.serviceId })
      .from(labTest)
      .where(eq(labTest.id, tsh.id));
    expect(row?.serviceId).toBe(id);
  });
});

describe('rates (paise, effective-dated, audited)', () => {
  it('lists services without a rate, sets one, and shows it', async () => {
    const nst = await svc('PROC-NST');
    const before = await admin.call((c) =>
      c.masters.listServiceRates({ tariffId: defaultTariffId, search: 'nst' }),
    );
    expect(before.rows[0]).toMatchObject({ code: 'PROC-NST', ratePaise: null });

    const res = await admin.call((c) =>
      c.masters.setServiceRate({
        serviceId: nst.id,
        tariffId: defaultTariffId,
        ratePaise: '45000',
        effectiveFrom: '2026-04-01',
      }),
    );
    expect(res.changed).toBe(true);
    const after = await admin.call((c) =>
      c.masters.listServiceRates({ tariffId: defaultTariffId, search: 'nst' }),
    );
    expect(after.rows[0]).toMatchObject({ ratePaise: 45000n, effectiveFrom: '2026-04-01' });

    const missing = await admin.call((c) =>
      c.masters.listServiceRates({ tariffId: defaultTariffId, onlyMissing: true, limit: 200 }),
    );
    expect(missing.rows.some((r) => r.code === 'PROC-NST')).toBe(false);
    expect(missing.rows.length).toBeGreaterThan(50);
  });

  it('records a future price change without touching today’s price', async () => {
    const nst = await svc('PROC-NST');
    await admin.call((c) =>
      c.masters.setServiceRate({
        serviceId: nst.id,
        tariffId: defaultTariffId,
        ratePaise: '50000',
        effectiveFrom: '2999-01-01',
      }),
    );
    const { rows } = await admin.call((c) =>
      c.masters.listServiceRates({ tariffId: defaultTariffId, search: 'nst' }),
    );
    expect(rows[0]).toMatchObject({ ratePaise: 45000n, nextChangeFrom: '2999-01-01' });
    const history = await admin.call((c) =>
      c.masters.listRateHistory({ serviceId: nst.id, tariffId: defaultTariffId }),
    );
    expect(history.map((h) => [h.effectiveFrom, h.ratePaise, h.status])).toEqual([
      ['2999-01-01', 50000n, 'active'],
      ['2026-04-01', 45000n, 'active'],
    ]);
  });

  it('a same-day correction cancels the old row instead of overwriting it', async () => {
    const nst = await svc('PROC-NST');
    await admin.call((c) =>
      c.masters.setServiceRate({
        serviceId: nst.id,
        tariffId: defaultTariffId,
        ratePaise: '42500',
        effectiveFrom: '2026-04-01',
      }),
    );
    const rows = await f.db.select().from(serviceRate).where(eq(serviceRate.serviceId, nst.id));
    expect(
      rows
        .filter((r) => r.effectiveFrom === '2026-04-01')
        .map((r) => [r.ratePaise, r.status])
        .sort(),
    ).toEqual([
      [42500n, 'active'],
      [45000n, 'cancelled'],
    ]);
    const audits = await f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tableName, 'service_rate'), eq(auditLog.changedBy, f.users.admin.id)));
    expect(audits.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses fractions, negatives and unknown services', async () => {
    const nst = await svc('PROC-NST');
    for (const ratePaise of [100.5, -1, 'abc']) {
      await expect(
        admin.call((c) =>
          c.masters.setServiceRate({
            serviceId: nst.id,
            tariffId: defaultTariffId,
            ratePaise,
            effectiveFrom: '2026-04-01',
          }),
        ),
      ).rejects.toThrow();
    }
    const err = await trpcError(
      admin.call((c) =>
        c.masters.setServiceRate({
          serviceId: '0190f0a0-0000-7000-8000-000000000009',
          tariffId: defaultTariffId,
          ratePaise: '100',
          effectiveFrom: '2026-04-01',
        }),
      ),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  it('does not leak another facility’s tariff', async () => {
    const err = await trpcError(
      adminB.call((c) => c.masters.listServiceRates({ tariffId: defaultTariffId })),
    );
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('doctors and consultation rules', () => {
  let doctorId: string;

  it('creates a doctor linked to a user; a user can be linked once', async () => {
    const dept = (await admin.call((c) => c.masters.listDepartments({ search: 'gynaecology' })))
      .rows[0]!;
    ({ id: doctorId } = await admin.call((c) =>
      c.masters.createDoctor({
        departmentId: dept.id,
        displayName: 'Dr. Test Doctor',
        userId: f.users.nurse.id,
        isVisiting: false,
        opdDays: ['mon', 'tue'],
        isActive: true,
      }),
    ));
    const err = await trpcError(
      admin.call((c) =>
        c.masters.createDoctor({
          departmentId: dept.id,
          displayName: 'Dr. Other',
          userId: f.users.nurse.id,
          isVisiting: false,
          opdDays: [],
          isActive: true,
        }),
      ),
    );
    expect(err.message).toBe('errors.masters.doctorUserTaken');
  });

  it('sets, replaces and cancels a rule; the fee comes from the default tariff', async () => {
    const gynNew = await svc('CONS-GYN-NEW');
    await admin.call((c) =>
      c.masters.setServiceRate({
        serviceId: gynNew.id,
        tariffId: defaultTariffId,
        ratePaise: '60000',
        effectiveFrom: '2026-04-01',
      }),
    );
    const { id } = await admin.call((c) =>
      c.masters.setConsultationRule({ doctorId, visitType: 'new', serviceId: gynNew.id }),
    );
    const again = await admin.call((c) =>
      c.masters.setConsultationRule({
        doctorId,
        visitType: 'new',
        serviceId: gynNew.id,
        followUpValidityDays: 10,
        freeFollowUpsCount: 2,
      }),
    );
    expect(again.id).toBe(id);
    const rules = await admin.call((c) => c.masters.listConsultationRules({ doctorId }));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      visitType: 'new',
      feePaise: 60000n,
      followUpValidityDays: 10,
      freeFollowUpsCount: 2,
    });

    const pap = await svc('PROC-PAP');
    expect(
      (
        await trpcError(
          admin.call((c) =>
            c.masters.setConsultationRule({ doctorId, visitType: 'follow_up', serviceId: pap.id }),
          ),
        )
      ).message,
    ).toBe('errors.masters.notConsultation');

    // A service used by an active rule cannot be cancelled.
    expect(
      (
        await trpcError(
          admin.call((c) => c.masters.cancelService({ id: gynNew.id, reason: 'try' })),
        )
      ).message,
    ).toBe('errors.masters.inUse');
    await admin.call((c) => c.masters.cancelConsultationRule({ id, reason: 'Fee changed' }));
    expect(await admin.call((c) => c.masters.listConsultationRules({ doctorId }))).toHaveLength(0);
  });
});

describe('runtime forbidden-term guard (issue #37, D-10)', () => {
  it('rejects a forbidden USG procedure name and logs the rejection without the text', async () => {
    const name = FORBIDDEN_TERMS.find((x) => x.id === 'pn01')!.examples[0]!;
    const err = await trpcError(
      admin.call((c) => c.masters.createUsgProcedure({ code: 'XS1', name, category: 'obstetric' })),
    );
    expect(err.code).toBe('BAD_REQUEST');
    const { rows } = await admin.call((c) => c.masters.listUsgProcedures({ search: 'XS1' }));
    expect(rows.find((r) => r.code === 'XS1')).toBeUndefined();

    const logs = await f.t.owner
      .select()
      .from(accessLog)
      .where(eq(accessLog.entity, 'forbidden_term_rejection'));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.purpose).toBe('input_rejected:masters.createUsgProcedure');
    expect(JSON.stringify(logs)).not.toContain(name);
  });
});
