/**
 * `db:seed --demo` skeleton (docs/02 §9, docs/50 PR 22). Each PR that adds data to the product
 * adds one step module here and appends it to `DEMO_STEPS`; steps run in order, are idempotent and
 * only use synthetic data from `people.ts` / `rng.ts`. Planned: PR 7 patients (500), PR 8 30 days
 * of OPD, PR 15 pregnancies (50), PR 16 children (80).
 */
import type { Tx } from '../../src/tx';
import type { MasterSeedResult } from '../masters';
import { demoDoctors } from './doctors';
import { demoRates } from './rates';
import { createRng, type Rng } from './rng';

export interface DemoContext {
  tx: Tx;
  facilityId: string;
  masters: MasterSeedResult;
  rng: Rng;
}

export interface DemoStep {
  name: string;
  /** Returns a one-line summary for the seed log. */
  run(ctx: DemoContext): Promise<string>;
}

export const DEMO_STEPS: readonly DemoStep[] = [demoDoctors, demoRates];

export const DEMO_SEED = 20261026;

export async function seedDemoData(
  tx: Tx,
  facilityId: string,
  masters: MasterSeedResult,
): Promise<string[]> {
  const ctx: DemoContext = { tx, facilityId, masters, rng: createRng(DEMO_SEED) };
  const log: string[] = [];
  for (const step of DEMO_STEPS) log.push(`${step.name}: ${await step.run(ctx)}`);
  return log;
}
