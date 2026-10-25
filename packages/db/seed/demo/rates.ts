import { rupeesToPaise } from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { service } from '../../schema';
import { getRate, setServiceRate } from '../../src/masters';
import type { DemoStep } from '.';

/**
 * SYNTHETIC demo prices in rupees, only so that demo and training machines can bill. They are not
 * a rate list and never run outside `--demo`: the hospital enters its own rates (docs/40 Q6/Q7).
 */
const DEMO_RUPEES: Record<string, number> = {
  'CONS-GYN-NEW': 500,
  'CONS-GYN-FU': 300,
  'CONS-ANC': 400,
  'CONS-EMG': 800,
  'CONS-PAED-NEW': 400,
  'CONS-PAED-FU': 250,
  'CONS-VACC': 150,
  'CONS-NIGHT': 700,
  'PROC-PAP': 600,
  'PROC-IUCD-INS': 800,
  'PROC-IUCD-REM': 500,
  'PROC-DRESS-S': 100,
  'PROC-DRESS-L': 250,
  'PROC-SUTURE-REM': 150,
  'PROC-INJ': 50,
  'PROC-IV-CANN': 150,
  'PROC-NEB': 100,
  'PROC-NST': 400,
  'USG-OB-EARLY': 800,
  'USG-NT': 1500,
  'USG-ANOMALY': 2000,
  'USG-GROWTH': 900,
  'USG-OB-DOPPLER': 1500,
  'USG-PELVIS-TAS': 700,
  'USG-PELVIS-TVS': 800,
  'USG-FOLLICULAR': 500,
  'USG-ABDOMEN': 800,
  'LAB-HB': 100,
  'LAB-CBC': 300,
  'LAB-RBS': 60,
  'LAB-ABO-RH': 100,
  'LAB-HIV': 250,
  'LAB-HBSAG': 250,
  'LAB-VDRL': 150,
  'LAB-UPT': 100,
  'LAB-URINE-RM': 100,
  'LAB-TSH': 350,
};

export const demoRates: DemoStep = {
  name: 'rates',
  async run({ tx, facilityId, masters }) {
    let set = 0;
    for (const [code, rupees] of Object.entries(DEMO_RUPEES)) {
      const [svc] = await tx
        .select({ id: service.id })
        .from(service)
        .where(
          and(
            eq(service.facilityId, facilityId),
            eq(service.code, code),
            eq(service.status, 'active'),
          ),
        );
      if (!svc) continue;
      // Never overwrite a rate someone entered: demo prices only fill empty slots.
      const current = await getRate(tx, {
        facilityId,
        serviceId: svc.id,
        tariffId: masters.defaultTariffId,
        on: '2999-12-31',
      });
      if (current) continue;
      const res = await setServiceRate(tx, {
        facilityId,
        serviceId: svc.id,
        tariffId: masters.defaultTariffId,
        ratePaise: rupeesToPaise(rupees),
        effectiveFrom: '2026-04-01',
      });
      if (res.changed) set += 1;
    }
    return `${set} synthetic demo rate(s) in the default tariff`;
  },
};
