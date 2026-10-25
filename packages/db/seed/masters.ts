/**
 * Platform + master seeds from docs/33 §1–3, §6–7. Idempotent and non-destructive: rows are
 * matched by their natural key and only missing ones are inserted, so re-running after the
 * hospital edited names or rates never overwrites anything. Rates are never seeded here (docs/33:
 * "names only where rates unknown"); the demo seed adds synthetic rates.
 */
import { uuidv7 } from 'uuidv7';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  department,
  labTest,
  payer,
  reasonCode,
  service,
  tariff,
  usgProcedure,
  drug,
} from '../schema';
import { ensureNumberSeriesRows } from '../src/number-series';
import type { Tx } from '../src/tx';
import { DEPARTMENTS } from './data/departments';
import { STARTER_DRUGS } from './data/drugs';
import { LAB_TESTS } from './data/lab-tests';
import { REASON_CODES } from './data/reasons';
import { SERVICES } from './data/services';
import { USG_PROCEDURES } from './data/usg';

export const SELF_PAYER_CODE = 'CASH';
export const DEFAULT_TARIFF_NAME = 'Standard (Cash)';

export interface MasterSeedResult {
  /** Rows inserted by this run per table (0 when everything was already present). */
  inserted: Record<string, number>;
  defaultTariffId: string;
  selfPayerId: string;
}

/** Inserts the rows whose key is not yet present; returns key → id for all rows of the list. */
async function insertMissing<S>(
  existing: readonly { id: string; key: string }[],
  wanted: readonly S[],
  keyOf: (s: S) => string,
  insert: (rows: { id: string; item: S }[]) => Promise<unknown>,
): Promise<{ ids: Map<string, string>; inserted: number }> {
  const ids = new Map(existing.map((r) => [r.key.toLowerCase(), r.id]));
  const fresh = wanted
    .filter((w) => !ids.has(keyOf(w).toLowerCase()))
    .map((item) => ({ id: uuidv7(), item }));
  if (fresh.length > 0) await insert(fresh);
  for (const f of fresh) ids.set(keyOf(f.item).toLowerCase(), f.id);
  return { ids, inserted: fresh.length };
}

export async function seedMasters(
  tx: Tx,
  facilityId: string,
  at = new Date(),
): Promise<MasterSeedResult> {
  const inserted: Record<string, number> = {};
  const count = (table: string, n: number) => (inserted[table] = (inserted[table] ?? 0) + n);

  count('number_series', await ensureNumberSeriesRows(tx, facilityId, at));

  const departments = await insertMissing(
    await tx
      .select({ id: department.id, key: department.code })
      .from(department)
      .where(eq(department.facilityId, facilityId)),
    DEPARTMENTS,
    (d) => d.code,
    (rows) =>
      tx.insert(department).values(
        rows.map(({ id, item }, i) => ({
          id,
          facilityId,
          code: item.code,
          name: item.name,
          nameHi: item.nameHi,
          isClinical: item.isClinical,
          isActive: item.isActive,
          sortOrder: (i + 1) * 10,
        })),
      ),
  );
  count('department', departments.inserted);

  // One payer (Cash / Self) and one default tariff (docs/33 §1). PM-JAY / TPA / corporate payers
  // are added by the hospital when PAY-01 ships; the tables already support them.
  const payers = await insertMissing(
    await tx
      .select({ id: payer.id, key: payer.code })
      .from(payer)
      .where(eq(payer.facilityId, facilityId)),
    [{ code: SELF_PAYER_CODE }],
    (p) => p.code,
    (rows) =>
      tx.insert(payer).values(
        rows.map(({ id }) => ({
          id,
          facilityId,
          code: SELF_PAYER_CODE,
          name: 'Cash / Self',
          type: 'self',
        })),
      ),
  );
  count('payer', payers.inserted);
  const selfPayerId = payers.ids.get(SELF_PAYER_CODE.toLowerCase())!;

  const tariffs = await insertMissing(
    await tx
      .select({ id: tariff.id, key: tariff.name })
      .from(tariff)
      .where(eq(tariff.facilityId, facilityId)),
    [{ name: DEFAULT_TARIFF_NAME }],
    (t) => t.name,
    (rows) =>
      tx.insert(tariff).values(
        rows.map(({ id }) => ({
          id,
          facilityId,
          name: DEFAULT_TARIFF_NAME,
          payerId: null,
          effectiveFrom: '2026-04-01',
        })),
      ),
  );
  count('tariff', tariffs.inserted);
  const defaultTariffId = tariffs.ids.get(DEFAULT_TARIFF_NAME.toLowerCase())!;

  const reasons = await insertMissing(
    (
      await tx
        .select({ id: reasonCode.id, kind: reasonCode.kind, code: reasonCode.code })
        .from(reasonCode)
        .where(eq(reasonCode.facilityId, facilityId))
    ).map((r) => ({ id: r.id, key: `${r.kind}/${r.code}` })),
    REASON_CODES,
    (r) => `${r.kind}/${r.code}`,
    (rows) =>
      tx.insert(reasonCode).values(
        rows.map(({ id, item }) => ({
          id,
          facilityId,
          kind: item.kind,
          code: item.code,
          label: item.label,
          labelHi: item.labelHi,
        })),
      ),
  );
  count('reason_code', reasons.inserted);

  const usg = await insertMissing(
    await tx
      .select({ id: usgProcedure.id, key: usgProcedure.code })
      .from(usgProcedure)
      .where(eq(usgProcedure.facilityId, facilityId)),
    USG_PROCEDURES,
    (u) => u.code,
    (rows) =>
      tx.insert(usgProcedure).values(
        rows.map(({ id, item }) => ({
          id,
          facilityId,
          code: item.code,
          name: item.name,
          category: item.category,
          requiresFormFIfPregnant: item.requiresFormFIfPregnant,
        })),
      ),
  );
  count('usg_procedure', usg.inserted);

  const labs = await insertMissing(
    await tx
      .select({ id: labTest.id, key: labTest.code })
      .from(labTest)
      .where(eq(labTest.facilityId, facilityId)),
    LAB_TESTS,
    (l) => l.code,
    (rows) =>
      tx.insert(labTest).values(
        rows.map(({ id, item }) => ({
          id,
          facilityId,
          code: item.code,
          name: item.name,
          department: item.department,
          resultType: item.resultType,
        })),
      ),
  );
  count('lab_test', labs.inserted);

  // Services: hand-listed ones plus one per USG procedure and per lab test (so orders can be
  // billed once the hospital enters a rate).
  const deptId = (code: string) => departments.ids.get(code.toLowerCase())!;
  const wantedServices = [
    ...SERVICES.map((x) => ({
      code: x.code,
      name: x.name,
      nameHi: x.nameHi,
      shortCode: x.shortCode ?? null,
      category: x.category,
      departmentId: deptId(x.dept),
      unit: x.unit ?? 'per_visit',
      linkedUsg: null as string | null,
      linkedLab: null as string | null,
    })),
    ...USG_PROCEDURES.map((u) => ({
      code: `USG-${u.code}`,
      name: u.name,
      nameHi: u.nameHi,
      shortCode: null,
      category: 'usg' as const,
      departmentId: deptId('RAD'),
      unit: 'per_unit' as const,
      linkedUsg: usg.ids.get(u.code.toLowerCase())!,
      linkedLab: null as string | null,
    })),
    ...LAB_TESTS.map((l) => ({
      code: `LAB-${l.code}`,
      name: l.name,
      nameHi: null,
      shortCode: null,
      category: 'lab' as const,
      departmentId: deptId('PATH'),
      unit: 'per_unit' as const,
      linkedUsg: null as string | null,
      linkedLab: labs.ids.get(l.code.toLowerCase())!,
    })),
  ];
  const services = await insertMissing(
    await tx
      .select({ id: service.id, key: service.code })
      .from(service)
      .where(eq(service.facilityId, facilityId)),
    wantedServices,
    (x) => x.code,
    async (rows) => {
      await tx.insert(service).values(
        rows.map(({ id, item }) => ({
          id,
          facilityId,
          code: item.code,
          name: item.name,
          nameHi: item.nameHi,
          shortCode: item.shortCode,
          category: item.category,
          departmentId: item.departmentId,
          unit: item.unit,
          isExempt: true,
          defaultGstRateBp: 0,
          sacCode: '9993',
          linkedUsgProcedureId: item.linkedUsg,
          linkedLabTestId: item.linkedLab,
        })),
      );
    },
  );
  count('service', services.inserted);

  // Back-link lab_test.service_id for tests that have none yet.
  const unlinked = await tx
    .select({ id: labTest.id, code: labTest.code })
    .from(labTest)
    .where(and(eq(labTest.facilityId, facilityId), isNull(labTest.serviceId)));
  for (const l of unlinked) {
    const serviceId = services.ids.get(`lab-${l.code}`.toLowerCase());
    if (serviceId) await tx.update(labTest).set({ serviceId }).where(eq(labTest.id, l.id));
  }

  const drugs = await insertMissing(
    (
      await tx
        .select({ id: drug.id, name: drug.brandName, strength: drug.strength, form: drug.form })
        .from(drug)
        .where(
          and(
            eq(drug.facilityId, facilityId),
            inArray(
              drug.brandName,
              STARTER_DRUGS.map((x) => x.name),
            ),
          ),
        )
    ).map((r) => ({ id: r.id, key: `${r.name}|${r.strength ?? ''}|${r.form}` })),
    STARTER_DRUGS,
    (x) => `${x.name}|${x.strength ?? ''}|${x.form}`,
    (rows) =>
      tx.insert(drug).values(
        rows.map(({ id, item }) => ({
          id,
          facilityId,
          brandName: item.name,
          genericName: item.name,
          shortCode: item.shortCode ?? null,
          strength: item.strength,
          form: item.form,
        })),
      ),
  );
  count('drug', drugs.inserted);

  return { inserted, defaultTariffId, selfPayerId };
}
