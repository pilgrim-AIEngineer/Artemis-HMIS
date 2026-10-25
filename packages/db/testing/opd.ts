/**
 * Test-only fixture for the OPD visit and queue tests: a facility with the seeded masters, three
 * doctors (two with consultation rules, one without), rates in the default tariff and helpers to
 * create patients and visits at a chosen business time.
 */
import { rupeesToPaise, type CreateVisitInput, type VisitType } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { consultationRule, department, doctorProfile, patient, service } from '../schema';
import { seedMasters, type MasterSeedResult } from '../seed/masters';
import { setServiceRate } from '../src/masters';
import { withTx, type Tx } from '../src/tx';
import { createVisit } from '../src/visits';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from './platform';

/** `IST('2026-10-26T10:00:00')` is that wall-clock time in Asia/Kolkata. */
export const IST = (iso: string) => new Date(`${iso}+05:30`);

export interface OpdFixture {
  t: PlatformTestDb;
  f: SeededFacility;
  m: MasterSeedResult;
  doctorA: string;
  doctorB: string;
  doctorNoRule: string;
  actor: () => { facilityId: string; userId: string };
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  newPatients: (n: number) => Promise<string[]>;
  newPatient: () => Promise<string>;
  visit: (over: Partial<CreateVisitInput>, now: Date) => ReturnType<typeof createVisit>;
}

export async function setupOpdFixture(adminUrl: string, poolMax = 30): Promise<OpdFixture> {
  const t = await setupPlatformDb(adminUrl, poolMax);
  const f = await seedFacility(t.owner);
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTx({ db: t.app, userId: f.userId, facilityId: f.facilityId }, fn);
  const m = await run((tx) => seedMasters(tx, f.facilityId, IST('2026-10-26T09:00:00')));

  const rate = async (code: string, rupees: number) => {
    const [row] = await t.app
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, f.facilityId), eq(service.code, code)));
    await run((tx) =>
      setServiceRate(tx, {
        facilityId: f.facilityId,
        serviceId: row!.id,
        tariffId: m.defaultTariffId,
        ratePaise: rupeesToPaise(rupees),
        effectiveFrom: '2026-01-01',
      }),
    );
  };
  await rate('CONS-GYN-NEW', 500);
  await rate('CONS-GYN-FU', 0);
  await rate('CONS-ANC', 400);

  const newDoctor = async (name: string, rules: [VisitType, string][]) => {
    const [dept] = await t.app
      .select({ id: department.id })
      .from(department)
      .where(and(eq(department.facilityId, f.facilityId), eq(department.code, 'GYN')));
    const id = uuidv7();
    await run(async (tx) => {
      await tx
        .insert(doctorProfile)
        .values({ id, facilityId: f.facilityId, departmentId: dept!.id, displayName: name });
      for (const [visitType, code] of rules) {
        const [s] = await tx
          .select({ id: service.id })
          .from(service)
          .where(and(eq(service.facilityId, f.facilityId), eq(service.code, code)));
        await tx.insert(consultationRule).values({
          id: uuidv7(),
          facilityId: f.facilityId,
          doctorId: id,
          visitType,
          serviceId: s!.id,
        });
      }
    });
    return id;
  };
  const doctorA = await newDoctor('Dr. A', [
    ['new', 'CONS-GYN-NEW'],
    ['follow_up', 'CONS-GYN-FU'],
    ['anc', 'CONS-ANC'],
  ]);
  const doctorB = await newDoctor('Dr. B', [['new', 'CONS-GYN-NEW']]);
  const doctorNoRule = await newDoctor('Dr. C', []);

  const newPatients = async (n: number) => {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: uuidv7(),
      facilityId: f.facilityId,
      uhid: `T-${uuidv7()}`,
      firstName: `P${i}`,
      sex: 'F',
      dob: '1990-01-01',
      mobile: '9876500000',
    }));
    await t.app.insert(patient).values(rows);
    return rows.map((r) => r.id);
  };

  const actor = () => ({ facilityId: f.facilityId, userId: f.userId });
  const [first] = await newPatients(1);
  return {
    t,
    f,
    m,
    doctorA,
    doctorB,
    doctorNoRule,
    actor,
    run,
    newPatients,
    newPatient: async () => (await newPatients(1))[0]!,
    visit: (over, now) =>
      run((tx) =>
        createVisit(
          tx,
          actor(),
          { patientId: first!, doctorId: doctorA, idempotencyKey: uuidv7(), ...over },
          now,
        ),
      ),
  };
}
