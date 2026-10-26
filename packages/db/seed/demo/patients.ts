import {
  createPatientSchema,
  transliterateToDevanagari,
  type CreatePatientInput,
} from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { patient } from '../../schema';
import { registerPatient } from '../../src/patients';
import type { DemoStep } from '.';
import { indianMobile, indianName } from './people';
import { int, pick } from './rng';

/** Marks seeded rows so a re-run adds nothing and staff can see they are not real. */
export const DEMO_PATIENT_TAG = 'Demo data';
export const DEMO_PATIENT_COUNT = 500;

const LOCALITIES = [
  'Civil Lines',
  'Station Road',
  'Gandhi Nagar',
  'Ram Nagar',
  'Shivpuri Colony',
  'Market Road',
  'Kisan Colony',
  'Azad Nagar',
  'Bus Stand Road',
  'Lal Bagh',
];
const OCCUPATIONS = ['Homemaker', 'Farmer', 'Teacher', 'Shopkeeper', 'Labourer', 'Student'];

/**
 * 500 synthetic patients in families sharing a mobile (docs/02 §9): mother, usually the father,
 * sometimes a child. Names are random combinations of common first names and surnames; mobiles
 * are `9xxxxxxxxx`. Goes through `registerPatient`, so UHIDs, search keys and audit are real.
 */
export const demoPatients: DemoStep = {
  name: 'patients',
  async run({ tx, facilityId, rng }) {
    const [have] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(patient)
      .where(and(eq(patient.facilityId, facilityId), eq(patient.referredBy, DEMO_PATIENT_TAG)));
    let total = have?.n ?? 0;
    if (total >= DEMO_PATIENT_COUNT) return `${total} already present`;
    const now = new Date();
    let created = 0;
    const add = async (input: CreatePatientInput) => {
      if (total + created >= DEMO_PATIENT_COUNT) return;
      const out = await registerPatient(
        tx,
        facilityId,
        createPatientSchema.parse({
          ...input,
          nameHi: transliterateToDevanagari(`${input.firstName} ${input.lastName ?? ''}`),
          referredBy: DEMO_PATIENT_TAG,
          duplicateOverride: { reason: 'Synthetic demo data' },
        }),
        now,
      );
      if (out.status === 'created') created += 1;
    };

    while (total + created < DEMO_PATIENT_COUNT) {
      const mobile = indianMobile(rng);
      const locality = pick(rng, LOCALITIES);
      const common = {
        mobile,
        localityName: locality,
        addressLine: `${int(rng, 1, 200)}, ${locality}`,
      };
      const mother = indianName(rng, 'F');
      const father = indianName(rng, 'M');
      const married = rng() < 0.85;
      await add({
        firstName: mother.first,
        lastName: married ? father.last : mother.last,
        sex: 'F',
        age: String(int(rng, 18, 45)),
        maritalStatus: married ? 'married' : 'single',
        occupation: pick(rng, OCCUPATIONS),
        relationToMobileOwner: 'wife',
        guardianName: married ? `${father.first} ${father.last}` : undefined,
        guardianRelation: married ? 'husband' : undefined,
        ...common,
      });
      if (married && rng() < 0.6) {
        await add({
          firstName: father.first,
          lastName: father.last,
          sex: 'M',
          age: String(int(rng, 22, 55)),
          maritalStatus: 'married',
          relationToMobileOwner: 'self',
          ...common,
        });
      }
      if (married && rng() < 0.55) {
        const childSex = rng() < 0.5 ? 'F' : 'M';
        const child = indianName(rng, childSex);
        await add({
          firstName: child.first,
          lastName: father.last,
          sex: childSex,
          // Mostly under 5 so the demo has children to immunise and weigh (children.ts).
          age: rng() < 0.5 ? `${int(rng, 1, 23)}m` : String(int(rng, 2, 8)),
          guardianName: `${father.first} ${father.last}`,
          guardianRelation: 'father',
          relationToMobileOwner: 'son',
          ...common,
        });
      }
    }
    total += created;
    return `${created} added (${total} demo patients, families share a mobile)`;
  },
};
