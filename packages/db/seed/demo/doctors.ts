import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { VisitType } from '@hmis/shared';
import { appUser, consultationRule, department, doctorProfile, service } from '../../schema';
import type { DemoStep } from '.';

interface DemoDoctor {
  displayName: string;
  displayNameHi: string;
  qualifications: string;
  dept: string;
  username: string | null;
  isVisiting: boolean;
  opdDays: string[];
  rules: [VisitType, string][];
}

/** Synthetic doctors with placeholder registration numbers; never real people. */
const DOCTORS: DemoDoctor[] = [
  {
    displayName: 'Dr. Sunita Verma',
    displayNameHi: 'डॉ. सुनीता वर्मा',
    qualifications: 'MBBS, MS (Obstetrics & Gynaecology)',
    dept: 'GYN',
    username: 'demo_doctor',
    isVisiting: false,
    opdDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    rules: [
      ['new', 'CONS-GYN-NEW'],
      ['follow_up', 'CONS-GYN-FU'],
      ['anc', 'CONS-ANC'],
      ['emergency', 'CONS-EMG'],
    ],
  },
  {
    displayName: 'Dr. Rakesh Gupta',
    displayNameHi: 'डॉ. राकेश गुप्ता',
    qualifications: 'MBBS, MD (Paediatrics)',
    dept: 'PAED',
    username: null,
    isVisiting: false,
    opdDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    rules: [
      ['new', 'CONS-PAED-NEW'],
      ['follow_up', 'CONS-PAED-FU'],
      ['paeds_vaccination', 'CONS-VACC'],
    ],
  },
  {
    displayName: 'Dr. Anita Mishra',
    displayNameHi: 'डॉ. अनीता मिश्रा',
    qualifications: 'MBBS, MD (Radiodiagnosis)',
    dept: 'RAD',
    username: 'demo_usg_doctor',
    isVisiting: true,
    opdDays: ['tue', 'thu', 'sat'],
    rules: [],
  },
];

export const demoDoctors: DemoStep = {
  name: 'doctors',
  async run({ tx, facilityId }) {
    let created = 0;
    for (const d of DOCTORS) {
      const [dept] = await tx
        .select({ id: department.id })
        .from(department)
        .where(and(eq(department.facilityId, facilityId), eq(department.code, d.dept)));
      if (!dept) continue;
      const [exists] = await tx
        .select({ id: doctorProfile.id })
        .from(doctorProfile)
        .where(
          and(
            eq(doctorProfile.facilityId, facilityId),
            eq(doctorProfile.displayName, d.displayName),
          ),
        );
      if (exists) continue;
      const [user] = d.username
        ? await tx
            .select({ id: appUser.id })
            .from(appUser)
            .where(and(eq(appUser.facilityId, facilityId), eq(appUser.username, d.username)))
        : [];
      const id = uuidv7();
      await tx.insert(doctorProfile).values({
        id,
        facilityId,
        userId: user?.id ?? null,
        departmentId: dept.id,
        displayName: d.displayName,
        displayNameHi: d.displayNameHi,
        qualifications: d.qualifications,
        registrationCouncil: 'Demo Medical Council',
        registrationNo: `DEMO-${created + 1}`,
        isVisiting: d.isVisiting,
        opdDays: d.opdDays,
      });
      for (const [visitType, code] of d.rules) {
        const [svc] = await tx
          .select({ id: service.id })
          .from(service)
          .where(and(eq(service.facilityId, facilityId), eq(service.code, code)));
        if (svc) {
          await tx
            .insert(consultationRule)
            .values({ id: uuidv7(), facilityId, doctorId: id, visitType, serviceId: svc.id });
        }
      }
      created += 1;
    }
    return `${created} new demo doctor(s)`;
  },
};
